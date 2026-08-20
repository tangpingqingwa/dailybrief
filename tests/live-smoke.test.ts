import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";
import { extractUnsubToken } from "../src/email/fake.js";
import { createFileEmail, readEmailSink } from "../src/email/file.js";
import {
  createEmail,
  parseEmailSinkPath,
  resolveEmailAdapter,
} from "../src/email/create.js";
import { openDatabase } from "../src/db.js";
import {
  LIVE_SMOKE_EMAIL,
  missingClipKey,
  missingMailVendorSecret,
  placeItemInDueWindow,
  runLiveSmoke,
  seedLiveSmokeUser,
} from "../src/live-smoke.js";
import { ALICE, ALICE_VIDEO_1, createFakeClip } from "./fake-clip.js";

const SECRET = "test-auth-secret-16";
const PUBLIC_BASE = "http://dailybrief.test";
const NOW = new Date("2026-08-19T12:00:00.000Z");

test("file EmailPort writes JSON the smoke can read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dailybrief-sink-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "sent.json");
  const email = createFileEmail(path);
  await email.send({
    to: "ada@example.com",
    subject: "DailyBrief — Wednesday",
    text: "Read source\nUnsubscribe: http://dailybrief.test/unsub/aaa.bbb",
  });
  const saved = readEmailSink(path);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.to, "ada@example.com");
  assert.match(saved[0]?.text ?? "", /\/unsub\//);
});

test("EMAIL_SINK=file wins over production fail-closed without a mail vendor", () => {
  assert.equal(parseEmailSinkPath({}), null);
  assert.equal(parseEmailSinkPath({ EMAIL_SINK: "file" }), null);
  assert.equal(
    parseEmailSinkPath({ EMAIL_SINK: "file", EMAIL_SINK_PATH: "/tmp/sent.json" }),
    "/tmp/sent.json",
  );
  assert.deepEqual(
    resolveEmailAdapter({
      NODE_ENV: "production",
      EMAIL_SINK: "file",
      EMAIL_SINK_PATH: "/tmp/sent.json",
    }),
    { kind: "console", path: "/tmp/sent.json" },
  );
  assert.equal(missingMailVendorSecret({ EMAIL_SINK: "file", EMAIL_SINK_PATH: "/x" }), null);
  assert.equal(missingMailVendorSecret({}), "EMAIL_LIVE");
  assert.equal(
    missingMailVendorSecret({ EMAIL_LIVE: "1", EMAIL_PROVIDER: "resend" }),
    "RESEND_API_KEY",
  );
  assert.equal(missingClipKey({}), "CLIPAPI_KEY");
  assert.equal(missingClipKey({ CLIPAPI_KEY: "ck_live_x" }), null);
});

test("createEmail file sink never fetches Resend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dailybrief-sink-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "sent.json");
  let calls = 0;
  const email = createEmail({
    env: {
      NODE_ENV: "production",
      EMAIL_SINK: "file",
      EMAIL_SINK_PATH: path,
    },
    fetch: async () => {
      calls += 1;
      throw new Error("network must not run");
    },
  });
  await email.send({
    to: "ada@example.com",
    subject: "hi",
    text: "body",
  });
  assert.equal(calls, 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).length, 1);
});

test("offline live-smoke ingest+send+unsub uses fake ClipAPI and file sink", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dailybrief-smoke-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "sent.json");
  const db = openDatabase(":memory:");
  const email = createFileEmail(path);
  const clip = createFakeClip();
  const app = await buildApp({
    db,
    email,
    clip,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    now: () => NOW,
  });
  after(async () => {
    await app.close();
    db.close();
  });

  const result = await runLiveSmoke({
    db,
    clip,
    email,
    authSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE,
    handle: ALICE,
    now: NOW,
    readSent: () => readEmailSink(path),
  });

  const ingest = result.cases.find((row) => row.name.startsWith("ingest"));
  const send = result.cases.find((row) => row.name.startsWith("EmailPort"));
  assert.equal(ingest?.verdict, "PASS");
  assert.equal(send?.verdict, "PASS");
  assert.ok(result.message);
  assert.match(result.message?.text ?? "", new RegExp(ALICE_VIDEO_1));
  const token = extractUnsubToken(result.message?.text ?? "");
  const unsub = await app.inject({ method: "GET", url: `/unsub/${token}` });
  assert.equal(unsub.statusCode, 200);
  assert.match(unsub.body, /unsubscribed/i);
  const user = seedLiveSmokeUser(db);
  assert.equal(user.email, LIVE_SMOKE_EMAIL);
  const row = db
    .prepare<[string], { unsubscribed_at: string | null }>(
      "SELECT unsubscribed_at FROM users WHERE id = ?",
    )
    .get(user.id);
  assert.ok(row?.unsubscribed_at);
});

test("placeItemInDueWindow moves a summarized item into today's send", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  seedLiveSmokeUser(db, { now: NOW });
  db.prepare(
    `INSERT INTO items (
       id, type, external_item_id, url, title, published_at,
       summary, summary_model, created_at
     ) VALUES (?, 'tiktok_creator', ?, ?, ?, ?, ?, 'fake', ?)`,
  ).run(
    "itm_old",
    "vid_old",
    "https://www.tiktok.com/@alice/video/vid_old",
    "Old clip",
    "2020-01-01T00:00:00.000Z",
    "A short summary.",
    NOW.toISOString(),
  );
  const placed = placeItemInDueWindow(db, NOW, "America/New_York");
  assert.ok(placed);
  assert.notEqual(placed?.published_at, "2020-01-01T00:00:00.000Z");
});
