import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openDatabase } from "../src/db.js";

const NOW = "2026-08-19T00:00:00.000Z";

test("migrate creates users, sources, items, deliveries", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());

  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);

  for (const name of ["users", "sources", "items", "deliveries", "schema_migrations"]) {
    assert.ok(tables.includes(name), `missing table ${name}`);
  }
  assert.ok(!tables.includes("user_sources"), "user_sources is not a v1 table");
});

test("users default timezone and plan; send_hour is fixed at 7", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());

  db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(
    "user_1",
    "a@example.com",
    NOW,
  );
  const row = db
    .prepare<[], { timezone: string; plan: string; send_hour: number }>(
      "SELECT timezone, plan, send_hour FROM users WHERE id = 'user_1'",
    )
    .get();
  assert.deepEqual(row, {
    timezone: "America/New_York",
    plan: "trial",
    send_hour: 7,
  });

  assert.throws(() => {
    db.prepare(
      "INSERT INTO users (id, email, plan, created_at) VALUES (?, ?, ?, ?)",
    ).run("user_bad_plan", "b@example.com", "enterprise", NOW);
  }, /CHECK|constraint/i);

  assert.throws(() => {
    db.prepare(
      "INSERT INTO users (id, email, send_hour, created_at) VALUES (?, ?, ?, ?)",
    ).run("user_bad_hour", "c@example.com", 8, NOW);
  }, /CHECK|constraint/i);

  assert.throws(() => {
    db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(
      "user_2",
      "a@example.com",
      NOW,
    );
  }, /UNIQUE|constraint/i);
});

test("sources are per-user; same handle may exist for two users", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());

  db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(
    "user_a",
    "a@example.com",
    NOW,
  );
  db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(
    "user_b",
    "b@example.com",
    NOW,
  );

  const insertSource = db.prepare(`
    INSERT INTO sources (id, user_id, type, external_id, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertSource.run("src_a", "user_a", "tiktok_creator", "alice", "Alice", NOW);
  insertSource.run("src_b", "user_b", "tiktok_creator", "alice", "Alice", NOW);

  assert.throws(() => {
    insertSource.run("src_dup", "user_a", "tiktok_creator", "alice", "Alice", NOW);
  }, /UNIQUE|constraint/i);

  assert.throws(() => {
    insertSource.run("src_orphan", "missing", "tiktok_creator", "bob", "Bob", NOW);
  }, /FOREIGN KEY|constraint/i);

  assert.throws(() => {
    insertSource.run("src_bad", "user_a", "youtube", "x", "X", NOW);
  }, /CHECK|constraint/i);
});

test("items are global: one row per (type, external_item_id); summary starts null", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());

  const insertItem = db.prepare(`
    INSERT INTO items (
      id, type, external_item_id, url, title, published_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertItem.run(
    "item_1",
    "tiktok_creator",
    "video_1",
    "https://www.tiktok.com/@alice/video/1",
    "One",
    NOW,
    NOW,
  );

  const row = db
    .prepare<[], { summary: string | null; transcript_or_body: string | null }>(
      "SELECT summary, transcript_or_body FROM items WHERE id = 'item_1'",
    )
    .get();
  assert.equal(row?.summary, null);
  assert.equal(row?.transcript_or_body, null);

  assert.throws(() => {
    insertItem.run(
      "item_dup",
      "tiktok_creator",
      "video_1",
      "https://www.tiktok.com/@alice/video/1",
      "Dup",
      NOW,
      NOW,
    );
  }, /UNIQUE|constraint/i);
});

test("deliveries are unique on (user_id, local_date)", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());

  db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(
    "user_1",
    "a@example.com",
    NOW,
  );

  const insertDelivery = db.prepare(`
    INSERT INTO deliveries (id, user_id, local_date, item_ids, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertDelivery.run("del_1", "user_1", "2026-08-19", "[]", NOW);

  const row = db
    .prepare<[], { partial: number; sent_at: string | null; provider_id: string | null }>(
      "SELECT partial, sent_at, provider_id FROM deliveries WHERE id = 'del_1'",
    )
    .get();
  assert.deepEqual(row, { partial: 0, sent_at: null, provider_id: null });

  assert.throws(() => {
    insertDelivery.run("del_2", "user_1", "2026-08-19", "[]", NOW);
  }, /UNIQUE|constraint/i);

  insertDelivery.run("del_3", "user_1", "2026-08-20", "[]", NOW);
});
