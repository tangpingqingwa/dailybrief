import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createClipClient, joinCues } from "../src/clients/clip.js";
import { openDatabase, type DailyBriefDb } from "../src/db.js";
import {
  itemId,
  listDistinctTiktokHandles,
  NO_TRANSCRIPT_MODEL,
  runIngest,
  summaryFromDescription,
  TIKTOK_CREATOR,
} from "../src/ingest.js";
import { createFakeSummary, FAKE_SUMMARY_MODEL, firstWords } from "../src/summary/fake.js";
import {
  ALICE,
  ALICE_CUES,
  ALICE_NO_CAPTION,
  ALICE_VIDEO_1,
  BOB,
  BOB_VIDEO_1,
  createFakeClip,
} from "./fake-clip.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");

type ItemRow = {
  id: string;
  type: string;
  external_item_id: string;
  summary: string | null;
  summary_model: string | null;
  transcript_or_body: string | null;
};

function seedUsersAndSources(
  db: DailyBriefDb,
  handles: Array<{ userId: string; email: string; handle: string }>,
): void {
  const insertUser = db.prepare(
    "INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)",
  );
  const insertSource = db.prepare(`
    INSERT INTO sources (id, user_id, type, external_id, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of handles) {
    insertUser.run(row.userId, row.email, NOW.toISOString());
    insertSource.run(
      `src_${row.userId}_${row.handle}`,
      row.userId,
      TIKTOK_CREATOR,
      row.handle,
      row.handle,
      NOW.toISOString(),
    );
  }
}

function allItems(db: DailyBriefDb): ItemRow[] {
  return db
    .prepare<[], ItemRow>(
      `SELECT id, type, external_item_id, summary, summary_model, transcript_or_body
       FROM items ORDER BY external_item_id`,
    )
    .all();
}

test("fake summary returns the first 80 words", async () => {
  const words = Array.from({ length: 90 }, (_, i) => `w${i + 1}`);
  const summary = await createFakeSummary().summarize(words.join(" "));
  assert.equal(summary.split(/\s+/).length, 80);
  assert.equal(summary, firstWords(words.join(" ")));
  assert.equal(joinCues(ALICE_CUES), "Stop fighting TikTok blocks. One credit, one JSON transcript.");
});

test("SPEC 1: three TikTok handles poll latest once each", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  seedUsersAndSources(db, [
    { userId: "user_a", email: "a@example.com", handle: "@Alice" },
    { userId: "user_a", email: "a@example.com", handle: "bob" },
    { userId: "user_b", email: "b@example.com", handle: "missing" },
  ]);
  const clip = createFakeClip({
    latest: { missing: "not_found" },
  });

  const result = await runIngest({
    db,
    clip,
    summary: createFakeSummary(),
    now: NOW,
  });

  assert.deepEqual(result.handlesPolled, ["alice", "bob", "missing"]);
  assert.deepEqual(clip.latestCalls, ["alice", "bob", "missing"]);
  assert.ok(result.delayedHandles.includes("missing"));
  assert.equal(result.partial, true);
  assert.ok(result.newItemIds.includes(itemId(TIKTOK_CREATOR, ALICE_VIDEO_1)));
  assert.ok(result.newItemIds.includes(itemId(TIKTOK_CREATOR, BOB_VIDEO_1)));
});

test("SPEC 3: two users following the same video share one items row", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  seedUsersAndSources(db, [
    { userId: "user_a", email: "a@example.com", handle: "alice" },
    { userId: "user_b", email: "b@example.com", handle: "@alice" },
  ]);
  const clip = createFakeClip();

  const first = await runIngest({
    db,
    clip,
    summary: createFakeSummary(),
    now: NOW,
  });
  const second = await runIngest({
    db,
    clip,
    summary: createFakeSummary(),
    now: NOW,
  });

  assert.deepEqual(listDistinctTiktokHandles(db), ["alice"]);
  assert.equal(clip.latestCalls.length, 2);
  assert.equal(
    clip.transcriptCalls.filter((id) => id === ALICE_VIDEO_1).length,
    1,
  );
  assert.deepEqual(second.newItemIds, []);
  assert.deepEqual(second.summarizedItemIds, []);

  const items = allItems(db);
  const shared = items.filter((row) => row.external_item_id === ALICE_VIDEO_1);
  assert.equal(shared.length, 1);
  assert.equal(shared[0]?.id, itemId(TIKTOK_CREATOR, ALICE_VIDEO_1));
  assert.equal(shared[0]?.summary, joinCues(ALICE_CUES));
  assert.equal(shared[0]?.summary_model, FAKE_SUMMARY_MODEL);
  assert.ok(first.summarizedItemIds.includes(shared[0]!.id));
});

test("no_transcript uses the first 200 chars of the description", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  seedUsersAndSources(db, [
    { userId: "user_a", email: "a@example.com", handle: "alice" },
  ]);
  const clip = createFakeClip();

  await runIngest({
    db,
    clip,
    summary: createFakeSummary(),
    now: NOW,
  });

  const row = db
    .prepare<[{ id: string }], ItemRow>(
      "SELECT id, type, external_item_id, summary, summary_model, transcript_or_body FROM items WHERE id = @id",
    )
    .get({ id: itemId(TIKTOK_CREATOR, ALICE_NO_CAPTION) });
  assert.ok(row);
  assert.equal(
    row.summary,
    summaryFromDescription("A public video with no caption track at all."),
  );
  assert.match(row.summary ?? "", /\(no transcript\)$/);
  assert.equal(row.summary_model, NO_TRANSCRIPT_MODEL);
  assert.ok((row.summary ?? "").length <= 200 + " (no transcript)".length);
});

test("SPEC 5: ClipAPI down inserts nothing and never scrapes", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  seedUsersAndSources(db, [
    { userId: "user_a", email: "a@example.com", handle: "alice" },
    { userId: "user_b", email: "b@example.com", handle: "bob" },
  ]);
  const clip = createFakeClip({
    latest: { [ALICE]: "clip_down", [BOB]: "upstream_blocked" },
  });

  const result = await runIngest({
    db,
    clip,
    summary: createFakeSummary(),
    now: NOW,
  });

  assert.deepEqual(result.newItemIds, []);
  assert.deepEqual(result.summarizedItemIds, []);
  assert.deepEqual(result.delayedHandles, [ALICE, BOB]);
  assert.equal(result.partial, true);
  assert.equal(clip.transcriptCalls.length, 0);
  assert.equal(allItems(db).length, 0);
});

test("ClipAPI down on transcript keeps the item unsummarized for retry", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  seedUsersAndSources(db, [
    { userId: "user_a", email: "a@example.com", handle: "alice" },
  ]);
  const clip = createFakeClip({
    transcripts: {
      [ALICE_VIDEO_1]: "clip_down",
      [ALICE_NO_CAPTION]: "no_transcript",
    },
  });

  const first = await runIngest({
    db,
    clip,
    summary: createFakeSummary(),
    now: NOW,
  });
  const pending = allItems(db).find((row) => row.external_item_id === ALICE_VIDEO_1);
  assert.ok(pending);
  assert.equal(pending.summary, null);
  assert.ok(first.delayedItemIds.includes(pending.id));
  assert.equal(first.partial, true);

  const recovered = createFakeClip({
    latest: { [ALICE]: [] },
    transcripts: {
      [ALICE_VIDEO_1]: {
        platform: "tiktok",
        videoId: ALICE_VIDEO_1,
        canonicalUrl: `https://www.tiktok.com/@alice/video/${ALICE_VIDEO_1}`,
        kind: "video",
        language: "en",
        durationMs: 8_400,
        author: { handle: ALICE, id: "user_alice" },
        metadata: {
          description: "Recorded caption fixture.",
          createTime: "2026-08-18T11:00:00.000Z",
          musicTitle: null,
        },
        source: "platform_caption",
        transcript: ALICE_CUES,
      },
    },
  });
  const second = await runIngest({
    db,
    clip: recovered,
    summary: createFakeSummary(),
    now: NOW,
  });
  assert.ok(second.summarizedItemIds.includes(pending.id));
  const done = allItems(db).find((row) => row.id === pending.id);
  assert.equal(done?.summary, joinCues(ALICE_CUES));
});

test("http Clip client stays offline without a base or key", async () => {
  const clip = createClipClient();
  const latest = await clip.getLatest({ handle: ALICE });
  const transcript = await clip.getTranscript({ videoId: ALICE_VIDEO_1 });
  assert.equal(latest.ok, false);
  if (!latest.ok) {
    assert.equal(latest.code, "clip_down");
    assert.equal(latest.http, 503);
  }
  assert.equal(transcript.ok, false);
  if (!transcript.ok) {
    assert.equal(transcript.code, "clip_down");
  }
});

test("http Clip client talks only to an injected fetch (fake ClipAPI)", async () => {
  const calls: string[] = [];
  const clip = createClipClient({
    base: "http://clip.test",
    key: "ck_test_dailybrief",
    fetch: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/latest")) {
        return new Response(
          JSON.stringify({
            data: {
              handle: ALICE,
              platform: "tiktok",
              videos: [
                {
                  videoId: ALICE_VIDEO_1,
                  title: "One",
                  description: "Desc",
                  author: { handle: ALICE, id: "u" },
                  lengthText: "0:08",
                  hasCaptions: true,
                  url: `https://www.tiktok.com/@alice/video/${ALICE_VIDEO_1}`,
                  createTime: "2026-08-18T11:00:00.000Z",
                },
              ],
              nextCursor: null,
            },
            meta: {
              cached: false,
              creditsCharged: 0,
              requestId: "req_fake",
              upstreamMs: 1,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            platform: "tiktok",
            videoId: ALICE_VIDEO_1,
            canonicalUrl: `https://www.tiktok.com/@alice/video/${ALICE_VIDEO_1}`,
            kind: "video",
            language: "en",
            durationMs: 1000,
            author: { handle: ALICE, id: "u" },
            metadata: {
              description: "Desc",
              createTime: "2026-08-18T11:00:00.000Z",
              musicTitle: null,
            },
            source: "platform_caption",
            transcript: ALICE_CUES,
          },
          meta: {
            cached: false,
            creditsCharged: 1,
            requestId: "req_fake",
            upstreamMs: 2,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const latest = await clip.getLatest({ handle: "@Alice" });
  const transcript = await clip.getTranscript({ videoId: ALICE_VIDEO_1 });
  assert.equal(latest.ok, true);
  assert.equal(transcript.ok, true);
  if (latest.ok) {
    assert.equal(latest.creditsCharged, 0);
    assert.equal(latest.data.videos[0]?.videoId, ALICE_VIDEO_1);
  }
  if (transcript.ok) {
    assert.equal(transcript.creditsCharged, 1);
    assert.equal(transcript.data.transcript.length, 2);
  }
  assert.equal(calls.length, 2);
  assert.match(calls[0] ?? "", /\/v1\/creators\/alice\/latest$/);
  assert.match(calls[1] ?? "", /\/v1\/transcript\?video_id=/);
});
