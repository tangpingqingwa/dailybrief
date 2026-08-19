import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHmac } from "node:crypto";
import { buildApp } from "../src/app.js";
import {
  MAGIC_LINK_TTL_MS,
  signMagicLink,
  signSession,
  verifyMagicLink,
  verifySession,
} from "../src/auth/token.js";
import { normalizeEmail } from "../src/auth/email.js";
import { APP_PATH, MAGIC_LINK_PATH, VERIFY_PATH } from "../src/auth/routes.js";
import { SESSION_COOKIE } from "../src/auth/cookie.js";
import { createFakeEmail, extractMagicLinkToken } from "../src/email/fake.js";

const SECRET = "test-auth-secret-16";
const OTHER_SECRET = "other-auth-secret16";
const NOW = new Date("2026-08-19T12:00:00.000Z");

function cookieHeader(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(first, "expected Set-Cookie");
  const pair = first.split(";", 1)[0];
  assert.ok(pair.includes("="), "expected name=value cookie");
  return pair;
}

async function requestLink(
  app: Awaited<ReturnType<typeof buildApp>>,
  email: FakeEmailHost,
  address: string,
): Promise<string> {
  const before = email.sent.length;
  const response = await app.inject({
    method: "POST",
    url: MAGIC_LINK_PATH,
    payload: { email: address },
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { ok: true });
  assert.equal(email.sent.length, before + 1);
  const last = email.sent[before];
  assert.equal(last.to, address.trim().toLowerCase());
  assert.match(last.subject, /DailyBrief/);
  return extractMagicLinkToken(last.text);
}

type FakeEmailHost = ReturnType<typeof createFakeEmail>;

test("normalizeEmail lowercases and rejects junk", () => {
  assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizeEmail(1), null);
});

test("signed magic link verifies, expires at 20 min, rejects wrong secret", () => {
  const { token, claims } = signMagicLink("ada@example.com", NOW, SECRET);
  assert.equal(claims.exp, NOW.getTime() + MAGIC_LINK_TTL_MS);
  assert.deepEqual(verifyMagicLink(token, NOW, SECRET), claims);
  assert.equal(
    verifyMagicLink(token, new Date(NOW.getTime() + MAGIC_LINK_TTL_MS), SECRET),
    null,
  );
  assert.ok(
    verifyMagicLink(
      token,
      new Date(NOW.getTime() + MAGIC_LINK_TTL_MS - 1),
      SECRET,
    ),
  );
  assert.equal(verifyMagicLink(token, NOW, OTHER_SECRET), null);
  const [body] = token.split(".");
  const badSig = createHmac("sha256", SECRET).update("tampered").digest("base64url");
  assert.equal(verifyMagicLink(`${body}.${badSig}`, NOW, SECRET), null);
  assert.equal(verifyMagicLink("not-a-token", NOW, SECRET), null);
});

test("POST /auth/magic-link sends one email via EmailPort and does not create a user", async () => {
  const email = createFakeEmail();
  const app = await buildApp({
    email,
    authSecret: SECRET,
    now: () => NOW,
    publicBaseUrl: "http://dailybrief.test",
  });
  after(() => app.close());

  const token = await requestLink(app, email, "Ada@Example.com");
  const claims = verifyMagicLink(token, NOW, SECRET);
  assert.ok(claims);
  assert.equal(claims.email, "ada@example.com");
  assert.match(email.sent[0].text, /http:\/\/dailybrief\.test\/auth\/verify\?token=/);

  const users = app.db.prepare("SELECT COUNT(*) AS n FROM users").get() as {
    n: number;
  };
  assert.equal(users.n, 0);

  const bad = await app.inject({
    method: "POST",
    url: MAGIC_LINK_PATH,
    payload: { email: "nope" },
  });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json(), { error: "invalid_email" });
  assert.equal(email.sent.length, 1);
});

test("GET /auth/verify sets a session cookie, creates the user once, and is single-use", async () => {
  const email = createFakeEmail();
  const app = await buildApp({
    email,
    authSecret: SECRET,
    now: () => NOW,
    publicBaseUrl: "http://dailybrief.test",
  });
  after(() => app.close());

  const token = await requestLink(app, email, "ada@example.com");
  const first = await app.inject({
    method: "GET",
    url: `${VERIFY_PATH}?token=${token}`,
  });
  assert.equal(first.statusCode, 302);
  assert.equal(first.headers.location, APP_PATH);
  const setCookie = first.headers["set-cookie"];
  const cookie = cookieHeader(setCookie);
  assert.match(String(setCookie), new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(String(setCookie), /HttpOnly/i);
  assert.match(String(setCookie), /SameSite=Lax/i);

  const me = await app.inject({
    method: "GET",
    url: APP_PATH,
    headers: { cookie },
  });
  assert.equal(me.statusCode, 200);
  const body = me.json() as {
    user: { email: string; plan: string; timezone: string; sendHour: number };
    sources: unknown[];
  };
  assert.equal(body.user.email, "ada@example.com");
  assert.equal(body.user.plan, "trial");
  assert.equal(body.user.timezone, "America/New_York");
  assert.equal(body.user.sendHour, 7);
  assert.deepEqual(body.sources, []);

  const replay = await app.inject({
    method: "GET",
    url: `${VERIFY_PATH}?token=${token}`,
  });
  assert.equal(replay.statusCode, 401);
  assert.deepEqual(replay.json(), { error: "invalid_token" });

  const again = await requestLink(app, email, "ada@example.com");
  const second = await app.inject({
    method: "GET",
    url: `${VERIFY_PATH}?token=${again}`,
  });
  assert.equal(second.statusCode, 302);
  const count = app.db.prepare("SELECT COUNT(*) AS n FROM users").get() as {
    n: number;
  };
  assert.equal(count.n, 1);
});

test("expired and forged tokens do not create a session", async () => {
  const email = createFakeEmail();
  let now = NOW;
  const app = await buildApp({
    email,
    authSecret: SECRET,
    now: () => now,
    publicBaseUrl: "http://dailybrief.test",
  });
  after(() => app.close());

  const token = await requestLink(app, email, "ada@example.com");
  now = new Date(NOW.getTime() + MAGIC_LINK_TTL_MS + 1);
  const expired = await app.inject({
    method: "GET",
    url: `${VERIFY_PATH}?token=${token}`,
  });
  assert.equal(expired.statusCode, 401);

  const forged = signMagicLink("ada@example.com", NOW, OTHER_SECRET).token;
  now = NOW;
  const bad = await app.inject({
    method: "GET",
    url: `${VERIFY_PATH}?token=${forged}`,
  });
  assert.equal(bad.statusCode, 401);

  const missing = await app.inject({ method: "GET", url: VERIFY_PATH });
  assert.equal(missing.statusCode, 401);

  const users = app.db.prepare("SELECT COUNT(*) AS n FROM users").get() as {
    n: number;
  };
  assert.equal(users.n, 0);
});

test("GET /app is 401 without a valid session; logout clears the cookie", async () => {
  const email = createFakeEmail();
  const app = await buildApp({
    email,
    authSecret: SECRET,
    now: () => NOW,
    publicBaseUrl: "http://dailybrief.test",
  });
  after(() => app.close());

  const anon = await app.inject({ method: "GET", url: APP_PATH });
  assert.equal(anon.statusCode, 401);
  assert.deepEqual(anon.json(), { error: "unauthorized" });

  const token = await requestLink(app, email, "ada@example.com");
  const verify = await app.inject({
    method: "GET",
    url: `${VERIFY_PATH}?token=${token}`,
  });
  const cookie = cookieHeader(verify.headers["set-cookie"]);

  const logout = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: { cookie },
  });
  assert.equal(logout.statusCode, 204);
  assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);

  const afterLogout = await app.inject({ method: "GET", url: APP_PATH });
  assert.equal(afterLogout.statusCode, 401);

  const expiredSession = signSession(
    "usr_missing",
    new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000),
    SECRET,
  );
  const stale = await app.inject({
    method: "GET",
    url: APP_PATH,
    headers: { cookie: `${SESSION_COOKIE}=${expiredSession}` },
  });
  assert.equal(stale.statusCode, 401);
  assert.equal(verifySession(expiredSession, NOW, SECRET), null);
});
