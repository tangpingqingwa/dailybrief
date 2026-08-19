import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";
import { MAGIC_LINK_PATH, VERIFY_PATH } from "../src/auth/routes.js";
import { setUserPlan } from "../src/auth/users.js";
import { createFakeStripe } from "../src/billing/fake.js";
import { SOURCE_CAPS } from "../src/billing/plans.js";
import { createFakeEmail, extractMagicLinkToken } from "../src/email/fake.js";
import { SOURCES_PATH, SOURCE_DELETE_PATH } from "../src/http/routes/sources.js";
import { parseTiktokSource } from "../src/sources.js";
import { createFakeClip } from "./fake-clip.js";

const SECRET = "test-auth-secret-16";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const PUBLIC_BASE = "http://dailybrief.test";

function cookieHeader(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(first, "expected Set-Cookie");
  return first.split(";", 1)[0];
}

function clipWithHandles(count: number): ReturnType<typeof createFakeClip> {
  const latest: Record<string, []> = {};
  for (let i = 0; i < count; i += 1) {
    latest[`c${i}`] = [];
  }
  return createFakeClip({ latest });
}

async function signIn(
  app: Awaited<ReturnType<typeof buildApp>>,
  email: ReturnType<typeof createFakeEmail>,
  address: string,
): Promise<{ cookie: string; userId: string }> {
  const sent = await app.inject({
    method: "POST",
    url: MAGIC_LINK_PATH,
    payload: { email: address },
  });
  assert.equal(sent.statusCode, 202);
  const token = extractMagicLinkToken(email.sent[email.sent.length - 1].text);
  const verify = await app.inject({
    method: "GET",
    url: `${VERIFY_PATH}?token=${token}`,
  });
  assert.equal(verify.statusCode, 302);
  const cookie = cookieHeader(verify.headers["set-cookie"]);
  const me = await app.inject({
    method: "GET",
    url: "/app",
    headers: { cookie },
  });
  const body = me.json() as { user: { id: string } };
  return { cookie, userId: body.user.id };
}

type App = Awaited<ReturnType<typeof buildApp>>;

async function addSource(
  app: App,
  cookie: string,
  handle: string,
): Promise<Awaited<ReturnType<App["inject"]>>> {
  return app.inject({
    method: "POST",
    url: SOURCES_PATH,
    headers: { cookie },
    payload: { handle },
  });
}

test("parseTiktokSource accepts @handle and profile URL, not other hosts", () => {
  assert.equal(parseTiktokSource("@Alice"), "alice");
  assert.equal(parseTiktokSource("https://www.tiktok.com/@alice/video/1"), "alice");
  assert.equal(parseTiktokSource("tiktok.com/@bob"), "bob");
  assert.equal(parseTiktokSource("https://vm.tiktok.com/abc"), null);
  assert.equal(parseTiktokSource("not a handle!"), null);
});

test("trial 4th source, starter 6th source, and pro 26th source are 400", async () => {
  const email = createFakeEmail();
  const clip = clipWithHandles(26);
  const app = await buildApp({
    email,
    stripe: createFakeStripe(),
    clip,
    authSecret: SECRET,
    now: () => NOW,
    publicBaseUrl: PUBLIC_BASE,
  });
  after(() => app.close());

  const { cookie, userId } = await signIn(app, email, "ada@example.com");

  for (let i = 0; i < SOURCE_CAPS.trial; i += 1) {
    const added = await addSource(app, cookie, `c${i}`);
    assert.equal(added.statusCode, 201, `trial source ${i} should succeed`);
  }
  const trialOver = await addSource(app, cookie, "c3");
  assert.equal(trialOver.statusCode, 400);
  assert.deepEqual(trialOver.json(), {
    error: "source_cap",
    plan: "trial",
    cap: 3,
    count: 3,
  });

  setUserPlan(app.db, userId, "starter");
  for (let i = SOURCE_CAPS.trial; i < SOURCE_CAPS.starter; i += 1) {
    const added = await addSource(app, cookie, `c${i}`);
    assert.equal(added.statusCode, 201, `starter source ${i} should succeed`);
  }
  const starterOver = await addSource(app, cookie, "c5");
  assert.equal(starterOver.statusCode, 400);
  assert.deepEqual(starterOver.json(), {
    error: "source_cap",
    plan: "starter",
    cap: 5,
    count: 5,
  });

  setUserPlan(app.db, userId, "pro");
  for (let i = SOURCE_CAPS.starter; i < SOURCE_CAPS.pro; i += 1) {
    const added = await addSource(app, cookie, `c${i}`);
    assert.equal(added.statusCode, 201, `pro source ${i} should succeed`);
  }
  const proOver = await addSource(app, cookie, "c25");
  assert.equal(proOver.statusCode, 400);
  assert.deepEqual(proOver.json(), {
    error: "source_cap",
    plan: "pro",
    cap: 25,
    count: 25,
  });
  assert.equal(clip.latestCalls.includes("c25"), false);
});

test("add source validates via fake ClipAPI latest; 404 refuses; delete works", async () => {
  const email = createFakeEmail();
  const clip = createFakeClip({ latest: { missing: "not_found", down: "clip_down" } });
  const app = await buildApp({
    email,
    stripe: createFakeStripe(),
    clip,
    authSecret: SECRET,
    now: () => NOW,
    publicBaseUrl: PUBLIC_BASE,
  });
  after(() => app.close());

  const anon = await app.inject({
    method: "POST",
    url: SOURCES_PATH,
    payload: { handle: "alice" },
  });
  assert.equal(anon.statusCode, 401);

  const { cookie } = await signIn(app, email, "ada@example.com");
  const created = await app.inject({
    method: "POST",
    url: SOURCES_PATH,
    headers: { cookie },
    payload: { url: "https://www.tiktok.com/@alice" },
  });
  assert.equal(created.statusCode, 201);
  const source = (created.json() as { source: { id: string; externalId: string } })
    .source;
  assert.equal(source.externalId, "alice");

  const dup = await addSource(app, cookie, "@Alice");
  assert.equal(dup.statusCode, 409);
  assert.deepEqual(dup.json(), { error: "source_exists" });

  const missing = await addSource(app, cookie, "missing");
  assert.equal(missing.statusCode, 400);
  assert.deepEqual(missing.json(), { error: "source_not_found" });

  const down = await addSource(app, cookie, "down");
  assert.equal(down.statusCode, 503);
  assert.deepEqual(down.json(), { error: "clip_down" });

  const reddit = await app.inject({
    method: "POST",
    url: SOURCES_PATH,
    headers: { cookie },
    payload: { type: "reddit_sub", handle: "alice" },
  });
  assert.equal(reddit.statusCode, 400);
  assert.deepEqual(reddit.json(), { error: "unsupported_type" });

  const removed = await app.inject({
    method: "POST",
    url: SOURCE_DELETE_PATH.replace(":id", source.id),
    headers: { cookie },
  });
  assert.equal(removed.statusCode, 200);
  const again = await app.inject({
    method: "POST",
    url: SOURCE_DELETE_PATH.replace(":id", source.id),
    headers: { cookie },
  });
  assert.equal(again.statusCode, 404);
});

test("FREEZE_NEW_SOURCES rejects non-tiktok types with 403", async () => {
  const email = createFakeEmail();
  const app = await buildApp({
    email,
    stripe: createFakeStripe(),
    clip: createFakeClip(),
    freezeNewSources: true,
    authSecret: SECRET,
    now: () => NOW,
    publicBaseUrl: PUBLIC_BASE,
  });
  after(() => app.close());
  const { cookie } = await signIn(app, email, "ada@example.com");
  const frozen = await app.inject({
    method: "POST",
    url: SOURCES_PATH,
    headers: { cookie },
    payload: { type: "reddit_sub", handle: "pics" },
  });
  assert.equal(frozen.statusCode, 403);
  assert.deepEqual(frozen.json(), { error: "frozen_type" });
  const tiktok = await addSource(app, cookie, "alice");
  assert.equal(tiktok.statusCode, 201);
});
