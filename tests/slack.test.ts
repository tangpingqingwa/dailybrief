import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";
import { APP_PATH, MAGIC_LINK_PATH, VERIFY_PATH } from "../src/auth/routes.js";
import { setUserPlan } from "../src/auth/users.js";
import { createFakeStripe } from "../src/billing/fake.js";
import { openDatabase, type DailyBriefDb } from "../src/db.js";
import { createFakeEmail, extractMagicLinkToken } from "../src/email/fake.js";
import { SLACK_DELETE_PATH, SLACK_PATH } from "../src/http/routes/slack.js";
import { TIKTOK_CREATOR } from "../src/ingest.js";
import { runDailySend } from "../src/send.js";
import { createFakeSlack } from "../src/slack/fake.js";
import { createSlackClient } from "../src/slack/http.js";
import { parseSlackWebhookUrl, slackEnabledForPlan } from "../src/slack/webhook.js";
import type { Plan } from "../src/types.js";

const SECRET = "test-auth-secret-16";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const PUBLIC_BASE = "http://dailybrief.test";
const PRO_WEBHOOK = "https://hooks.slack.test/services/T000/B000/XXXXXXXX";

function cookieHeader(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(first, "expected Set-Cookie");
  return first.split(";", 1)[0];
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
    url: APP_PATH,
    headers: { cookie },
  });
  const body = me.json() as { user: { id: string } };
  return { cookie, userId: body.user.id };
}

function seedUser(
  db: DailyBriefDb,
  args: {
    id: string;
    email: string;
    plan?: Plan;
    slackWebhookUrl?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO users (id, email, timezone, plan, slack_webhook_url, created_at)
     VALUES (?, ?, 'America/New_York', ?, ?, ?)`,
  ).run(
    args.id,
    args.email,
    args.plan ?? "pro",
    args.slackWebhookUrl ?? null,
    NOW.toISOString(),
  );
}

function seedSource(db: DailyBriefDb, userId: string): void {
  db.prepare(
    `INSERT INTO sources (id, user_id, type, external_id, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("src_a", userId, TIKTOK_CREATOR, "alice", "Alice", NOW.toISOString());
}

function seedItem(db: DailyBriefDb): void {
  db.prepare(
    `INSERT INTO items (
       id, type, external_item_id, url, title, published_at,
       summary, summary_model, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "item_1",
    TIKTOK_CREATOR,
    "vid_1",
    "https://www.tiktok.com/@alice/video/vid_1",
    "Before seven",
    "2026-08-19T10:00:00.000Z",
    "Hook: a new public clip landed just before the cutoff.",
    "fake",
    NOW.toISOString(),
  );
}

test("Slack is Pro-only; parseSlackWebhookUrl requires https", () => {
  assert.equal(slackEnabledForPlan("pro"), true);
  assert.equal(slackEnabledForPlan("starter"), false);
  assert.equal(slackEnabledForPlan("trial"), false);
  assert.equal(parseSlackWebhookUrl(PRO_WEBHOOK), PRO_WEBHOOK);
  assert.equal(parseSlackWebhookUrl("https://hooks.slack.com/services/T000/B000/XXXX"), "https://hooks.slack.com/services/T000/B000/XXXX");
  assert.equal(parseSlackWebhookUrl("http://hooks.slack.test/services/T/B/X"), null);
  assert.equal(parseSlackWebhookUrl("https://example.com/services/T/B/X"), null);
  assert.equal(parseSlackWebhookUrl("not-a-url"), null);
  assert.equal(parseSlackWebhookUrl("https://user:pass@hooks.slack.test/x"), null);
});

test("createSlackClient is fail-closed and never talks to Slack", async () => {
  const slack = createSlackClient();
  const result = await slack.post(PRO_WEBHOOK, { text: "hello" });
  assert.deepEqual(result, { ok: false, status: 503 });
});

test("POST /app/slack is 403 for starter and trial; Pro can save and clear", async () => {
  const email = createFakeEmail();
  const stripe = createFakeStripe();
  const app = await buildApp({
    email,
    stripe,
    authSecret: SECRET,
    now: () => NOW,
    publicBaseUrl: PUBLIC_BASE,
  });
  after(() => app.close());

  const anon = await app.inject({ method: "GET", url: SLACK_PATH });
  assert.equal(anon.statusCode, 401);

  const { cookie, userId } = await signIn(app, email, "ada@example.com");
  const trialGet = await app.inject({
    method: "GET",
    url: SLACK_PATH,
    headers: { cookie },
  });
  assert.equal(trialGet.statusCode, 200);
  assert.deepEqual(trialGet.json(), {
    plan: "trial",
    slackEnabled: false,
    configured: false,
  });

  const trialPost = await app.inject({
    method: "POST",
    url: SLACK_PATH,
    headers: { cookie },
    payload: { webhookUrl: PRO_WEBHOOK },
  });
  assert.equal(trialPost.statusCode, 403);
  assert.deepEqual(trialPost.json(), { error: "slack_not_allowed" });

  setUserPlan(app.db, userId, "starter");
  const starterPost = await app.inject({
    method: "POST",
    url: SLACK_PATH,
    headers: { cookie },
    payload: { webhookUrl: PRO_WEBHOOK },
  });
  assert.equal(starterPost.statusCode, 403);
  assert.deepEqual(starterPost.json(), { error: "slack_not_allowed" });
  const storedAfterStarter = app.db
    .prepare<[string], { slack_webhook_url: string | null }>(
      "SELECT slack_webhook_url FROM users WHERE id = ?",
    )
    .get(userId);
  assert.equal(storedAfterStarter?.slack_webhook_url, null);

  setUserPlan(app.db, userId, "pro");
  const badUrl = await app.inject({
    method: "POST",
    url: SLACK_PATH,
    headers: { cookie },
    payload: { webhookUrl: "http://hooks.slack.com/services/T/B/X" },
  });
  assert.equal(badUrl.statusCode, 400);
  assert.deepEqual(badUrl.json(), { error: "invalid_webhook" });

  const saved = await app.inject({
    method: "POST",
    url: SLACK_PATH,
    headers: { cookie },
    payload: { webhookUrl: PRO_WEBHOOK },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json(), { ok: true, configured: true });

  const afterSave = await app.inject({
    method: "GET",
    url: SLACK_PATH,
    headers: { cookie },
  });
  assert.deepEqual(afterSave.json(), {
    plan: "pro",
    slackEnabled: true,
    configured: true,
  });
  assert.doesNotMatch(afterSave.body, /hooks\.slack/);

  const cleared = await app.inject({
    method: "POST",
    url: SLACK_DELETE_PATH,
    headers: { cookie },
  });
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(cleared.json(), { ok: true, configured: false });
});

test("Pro send posts the same text to Slack; Starter never posts", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const email = createFakeEmail();
  const slack = createFakeSlack();
  seedUser(db, {
    id: "user_pro",
    email: "pro@example.com",
    plan: "pro",
    slackWebhookUrl: PRO_WEBHOOK,
  });
  seedUser(db, {
    id: "user_starter",
    email: "starter@example.com",
    plan: "starter",
    slackWebhookUrl: PRO_WEBHOOK,
  });
  seedSource(db, "user_pro");
  db.prepare(
    `INSERT INTO sources (id, user_id, type, external_id, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "src_starter",
    "user_starter",
    TIKTOK_CREATOR,
    "alice",
    "Alice",
    NOW.toISOString(),
  );
  seedItem(db);

  const result = await runDailySend({
    db,
    email,
    slack,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: NOW,
  });

  const pro = result.deliveries.find((row) => row.userId === "user_pro");
  const starter = result.deliveries.find((row) => row.userId === "user_starter");
  assert.equal(pro?.sent, true);
  assert.equal(pro?.slack, "sent");
  assert.equal(starter?.sent, true);
  assert.equal(starter?.slack, "skipped");
  assert.equal(email.sent.length, 2);
  assert.equal(slack.posted.length, 1);
  assert.equal(slack.posted[0]?.webhookUrl, PRO_WEBHOOK);
  assert.equal(slack.posted[0]?.text, email.sent[0]?.text);
  assert.match(slack.posted[0]?.text ?? "", /Before seven/);
});

test("Slack post throw still sends email", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const email = createFakeEmail();
  const slack = createFakeSlack();
  slack.throwOnPost(new Error("network"));
  seedUser(db, {
    id: "user_pro",
    email: "pro@example.com",
    plan: "pro",
    slackWebhookUrl: PRO_WEBHOOK,
  });
  seedSource(db, "user_pro");
  seedItem(db);

  const result = await runDailySend({
    db,
    email,
    slack,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: NOW,
  });

  assert.equal(result.sent, 1);
  assert.equal(result.deliveries[0]?.slack, "failed");
  assert.equal(email.sent.length, 1);
});

test("Slack 4xx still sends email and records the delivery", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const email = createFakeEmail();
  const slack = createFakeSlack();
  slack.setStatus(PRO_WEBHOOK, 400);
  seedUser(db, {
    id: "user_pro",
    email: "pro@example.com",
    plan: "pro",
    slackWebhookUrl: PRO_WEBHOOK,
  });
  seedSource(db, "user_pro");
  seedItem(db);

  const result = await runDailySend({
    db,
    email,
    slack,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: NOW,
  });

  assert.equal(result.sent, 1);
  assert.equal(result.deliveries[0]?.slack, "failed");
  assert.equal(email.sent.length, 1);
  assert.equal(slack.posted.length, 1);
  assert.equal(slack.posted[0]?.status, 400);
  const row = db
    .prepare<[], { sent_at: string | null; item_ids: string }>(
      "SELECT sent_at, item_ids FROM deliveries WHERE user_id = 'user_pro'",
    )
    .get();
  assert.ok(row?.sent_at);
  assert.equal(row?.item_ids, '["item_1"]');
});
