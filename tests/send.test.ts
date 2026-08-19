import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";
import { signUnsub, verifyUnsub } from "../src/auth/token.js";
import { openDatabase, type DailyBriefDb } from "../src/db.js";
import { createFakeEmail, extractUnsubToken } from "../src/email/fake.js";
import {
  DELAYED_HEADLINE,
  EMPTY_BODY_LINE,
} from "../src/email/templates/daily.js";
import { TIKTOK_CREATOR } from "../src/ingest.js";
import {
  dueLocalDate,
  itemInWindow,
  runDailySend,
  sendWindowUtc,
  zonedLocalTimeToUtc,
} from "../src/send.js";
import type { Plan } from "../src/types.js";

const SECRET = "test-auth-secret-16";
const OTHER_SECRET = "other-auth-secret16";
const TZ = "America/New_York";
const PUBLIC_BASE = "http://dailybrief.test";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const LOCAL_DATE = "2026-08-19";

type DeliveryRow = {
  id: string;
  user_id: string;
  local_date: string;
  item_ids: string;
  sent_at: string | null;
  partial: number;
};

function seedUser(
  db: DailyBriefDb,
  args: {
    id: string;
    email: string;
    plan?: Plan;
    timezone?: string;
    unsubscribedAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO users (id, email, timezone, plan, unsubscribed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.email,
    args.timezone ?? TZ,
    args.plan ?? "starter",
    args.unsubscribedAt ?? null,
    NOW.toISOString(),
  );
}

function seedSource(
  db: DailyBriefDb,
  args: { id: string; userId: string; handle: string; label?: string },
): void {
  db.prepare(
    `INSERT INTO sources (id, user_id, type, external_id, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.userId,
    TIKTOK_CREATOR,
    args.handle,
    args.label ?? args.handle,
    NOW.toISOString(),
  );
}

function seedItem(
  db: DailyBriefDb,
  args: {
    id: string;
    videoId: string;
    handle: string;
    publishedAt: string;
    title?: string;
    summary?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO items (
       id, type, external_item_id, url, title, published_at,
       summary, summary_model, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    TIKTOK_CREATOR,
    args.videoId,
    `https://www.tiktok.com/@${args.handle}/video/${args.videoId}`,
    args.title ?? `Video ${args.videoId}`,
    args.publishedAt,
    args.summary === undefined ? "A short shared summary of the video." : args.summary,
    args.summary === null ? null : "fake",
    NOW.toISOString(),
  );
}

function deliveries(db: DailyBriefDb): DeliveryRow[] {
  return db
    .prepare<[], DeliveryRow>(
      `SELECT id, user_id, local_date, item_ids, sent_at, partial
       FROM deliveries ORDER BY local_date, user_id`,
    )
    .all();
}

test("window: 06:59 local is included; 07:00 local is the next send", () => {
  const window = sendWindowUtc(LOCAL_DATE, TZ);
  assert.equal(window.start.toISOString(), "2026-08-18T11:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-08-19T11:00:00.000Z");
  assert.equal(
    zonedLocalTimeToUtc(LOCAL_DATE, 7, TZ).toISOString(),
    "2026-08-19T11:00:00.000Z",
  );
  assert.equal(itemInWindow("2026-08-19T10:59:00.000Z", window), true);
  assert.equal(itemInWindow("2026-08-19T11:00:00.000Z", window), false);
  assert.equal(dueLocalDate(NOW, TZ), LOCAL_DATE);
  assert.equal(dueLocalDate(new Date("2026-08-19T10:59:00.000Z"), TZ), "2026-08-18");
});

test("SPEC 2: item published before 07:00 local is in that day's mail", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const email = createFakeEmail();
  seedUser(db, { id: "user_a", email: "a@example.com" });
  seedSource(db, { id: "src_a", userId: "user_a", handle: "alice", label: "Alice" });
  seedItem(db, {
    id: "item_in",
    videoId: "vid_in",
    handle: "alice",
    publishedAt: "2026-08-19T10:59:00.000Z",
    title: "Before seven",
    summary: "Hook: a new public clip landed just before the cutoff.",
  });
  seedItem(db, {
    id: "item_out",
    videoId: "vid_out",
    handle: "alice",
    publishedAt: "2026-08-19T11:00:00.000Z",
    title: "At seven",
    summary: "This belongs to tomorrow.",
  });

  const result = await runDailySend({
    db,
    email,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: NOW,
  });

  assert.equal(result.sent, 1);
  assert.deepEqual(result.deliveries[0]?.itemIds, ["item_in"]);
  assert.equal(email.sent.length, 1);
  const mail = email.sent[0];
  assert.equal(mail.to, "a@example.com");
  assert.equal(mail.subject, "DailyBrief — 1 new from your sources");
  assert.match(mail.text, /Alice/);
  assert.match(mail.text, /Before seven/);
  assert.match(mail.text, /Hook: a new public clip landed just before the cutoff/);
  assert.match(mail.text, /Read source: https:\/\/www\.tiktok\.com\/@alice\/video\/vid_in/);
  assert.doesNotMatch(mail.text, /At seven/);
  assert.match(mail.html ?? "", /Read source/);
  assert.match(mail.html ?? "", /Powered by the same APIs we sell/);
  assert.match(mail.text, /List-Unsubscribe|Unsubscribe: http:\/\/dailybrief\.test\/unsub\//);
  assert.equal(mail.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(mail.headers?.["List-Unsubscribe"] ?? "", /<http:\/\/dailybrief\.test\/unsub\//);

  const rows = deliveries(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.local_date, LOCAL_DATE);
  assert.equal(rows[0]?.partial, 0);
  assert.equal(rows[0]?.sent_at, NOW.toISOString());
  assert.equal(rows[0]?.item_ids, '["item_in"]');
});

test("SPEC 6: paid empty window still sends the one-line template", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const email = createFakeEmail();
  seedUser(db, { id: "user_paid", email: "paid@example.com", plan: "starter" });
  seedSource(db, { id: "src_paid", userId: "user_paid", handle: "alice" });

  const result = await runDailySend({
    db,
    email,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: NOW,
  });

  assert.equal(result.sent, 1);
  assert.equal(email.sent.length, 1);
  assert.equal(email.sent[0].subject, "DailyBrief — Wednesday");
  assert.match(email.sent[0].text, new RegExp(EMPTY_BODY_LINE));
  assert.match(email.sent[0].html ?? "", /Nothing new yesterday/);
  assert.equal(deliveries(db)[0]?.item_ids, "[]");
  assert.equal(deliveries(db)[0]?.partial, 0);
});

test("trial empty window skips the mail but still records the day", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const email = createFakeEmail();
  seedUser(db, { id: "user_trial", email: "trial@example.com", plan: "trial" });
  seedSource(db, { id: "src_trial", userId: "user_trial", handle: "alice" });

  const result = await runDailySend({
    db,
    email,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: NOW,
  });

  assert.equal(result.sent, 0);
  assert.equal(result.deliveries[0]?.skipped, "empty_trial");
  assert.equal(email.sent.length, 0);
  const row = deliveries(db)[0];
  assert.ok(row);
  assert.equal(row.local_date, LOCAL_DATE);
  assert.equal(row.sent_at, NOW.toISOString());
  assert.equal(row.item_ids, "[]");
});

test("trial footer watermark appears when a trial user has items", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const email = createFakeEmail();
  seedUser(db, { id: "user_trial", email: "trial@example.com", plan: "trial" });
  seedSource(db, { id: "src_trial", userId: "user_trial", handle: "alice" });
  seedItem(db, {
    id: "item_trial",
    videoId: "vid_trial",
    handle: "alice",
    publishedAt: "2026-08-19T10:00:00.000Z",
  });

  await runDailySend({
    db,
    email,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: NOW,
  });

  assert.equal(email.sent.length, 1);
  assert.match(email.sent[0].text, /^[\s\S]*\ntrial$/m);
  assert.match(email.sent[0].html ?? "", /<p>trial<\/p>/);
});

test("SPEC 4: one-click unsub needs no login and stops later sends", async () => {
  const db = openDatabase(":memory:");
  const email = createFakeEmail();
  const app = await buildApp({
    db,
    email,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: () => NOW,
  });
  after(async () => {
    await app.close();
    db.close();
  });

  seedUser(db, { id: "user_a", email: "a@example.com", plan: "pro" });
  seedSource(db, { id: "src_a", userId: "user_a", handle: "alice" });
  seedItem(db, {
    id: "item_1",
    videoId: "vid_1",
    handle: "alice",
    publishedAt: "2026-08-19T10:00:00.000Z",
  });

  await runDailySend({
    db,
    email,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: NOW,
  });
  assert.equal(email.sent.length, 1);
  const token = extractUnsubToken(email.sent[0].text);
  assert.deepEqual(verifyUnsub(token, SECRET), {
    v: 1,
    kind: "unsub",
    sub: "user_a",
  });
  assert.equal(verifyUnsub(token, OTHER_SECRET), null);

  const anon = await app.inject({ method: "GET", url: `/unsub/${token}` });
  assert.equal(anon.statusCode, 200);
  assert.match(anon.body, /unsubscribed/i);
  assert.equal(anon.headers["content-type"], "text/plain; charset=utf-8");

  const again = await app.inject({ method: "POST", url: `/unsub/${token}` });
  assert.equal(again.statusCode, 200);
  assert.match(again.body, /already unsubscribed/i);

  const forged = await app.inject({
    method: "GET",
    url: `/unsub/${signUnsub("user_a", OTHER_SECRET)}`,
  });
  assert.equal(forged.statusCode, 401);

  email.sent.length = 0;
  const next = await runDailySend({
    db,
    email,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: new Date("2026-08-20T12:00:00.000Z"),
  });
  assert.equal(next.sent, 0);
  assert.equal(next.deliveries[0]?.skipped, "unsubscribed");
  assert.equal(email.sent.length, 0);
});

test("clip down records partial=1 and says the source was delayed", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const email = createFakeEmail();
  seedUser(db, { id: "user_a", email: "a@example.com", plan: "starter" });
  seedSource(db, {
    id: "src_a",
    userId: "user_a",
    handle: "alice",
    label: "Alice",
  });
  seedItem(db, {
    id: "item_pending",
    videoId: "vid_pending",
    handle: "alice",
    publishedAt: "2026-08-19T10:00:00.000Z",
    summary: null,
  });

  const result = await runDailySend({
    db,
    email,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: NOW,
    delayedHandles: ["alice"],
  });

  assert.equal(result.sent, 1);
  assert.equal(result.deliveries[0]?.partial, true);
  assert.equal(email.sent.length, 1);
  assert.ok(email.sent[0].text.includes(DELAYED_HEADLINE));
  assert.match(email.sent[0].text, /Alice: source delayed/);
  assert.doesNotMatch(email.sent[0].text, /tiktok\.com\/@alice\/video\/vid_pending/);
  const row = deliveries(db)[0];
  assert.equal(row?.partial, 1);
  assert.equal(row?.item_ids, "[]");
  assert.ok(row?.sent_at);
});

test("second run for the same local date does not send again", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const email = createFakeEmail();
  seedUser(db, { id: "user_a", email: "a@example.com" });
  seedSource(db, { id: "src_a", userId: "user_a", handle: "alice" });
  seedItem(db, {
    id: "item_1",
    videoId: "vid_1",
    handle: "alice",
    publishedAt: "2026-08-19T10:00:00.000Z",
  });

  const first = await runDailySend({
    db,
    email,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: NOW,
  });
  const second = await runDailySend({
    db,
    email,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: NOW,
  });

  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(second.deliveries[0]?.skipped, "already_processed");
  assert.equal(email.sent.length, 1);
  assert.equal(deliveries(db).length, 1);
});
