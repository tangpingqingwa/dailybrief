import { createHash } from "node:crypto";
import {
  joinCues,
  type ClipClient,
  type ClipCreatorVideo,
  type ClipErrorCode,
  normalizeCreatorHandle,
} from "./clients/clip.js";
import type { DailyBriefDb } from "./db.js";
import { FAKE_SUMMARY_MODEL } from "./summary/fake.js";
import type { SummaryPort } from "./summary/port.js";
import type { SourceType } from "./types.js";

export const TIKTOK_CREATOR: SourceType = "tiktok_creator";
export const NO_TRANSCRIPT_SUFFIX = " (no transcript)";
export const NO_TRANSCRIPT_DESCRIPTION_CHARS = 200;
export const NO_TRANSCRIPT_MODEL = "none";

export type IngestDeps = {
  db: DailyBriefDb;
  clip: ClipClient;
  summary: SummaryPort;
  now?: Date;
  summaryModel?: string;
};

export type IngestResult = {
  handlesPolled: string[];
  newItemIds: string[];
  summarizedItemIds: string[];
  delayedHandles: string[];
  delayedItemIds: string[];
  partial: boolean;
};

type HandleRow = { external_id: string };

type ItemRow = {
  id: string;
  external_item_id: string;
  url: string;
  transcript_or_body: string | null;
};

export function itemId(type: SourceType, externalItemId: string): string {
  const digest = createHash("sha256")
    .update(`${type}\0${externalItemId}`)
    .digest("hex");
  return `itm_${digest.slice(0, 32)}`;
}

export function summaryFromDescription(description: string | null | undefined): string {
  const prefix = (description ?? "").slice(0, NO_TRANSCRIPT_DESCRIPTION_CHARS);
  return `${prefix}${NO_TRANSCRIPT_SUFFIX}`;
}

export function listDistinctTiktokHandles(db: DailyBriefDb): string[] {
  const rows = db
    .prepare<[string], HandleRow>(
      "SELECT DISTINCT external_id FROM sources WHERE type = ?",
    )
    .all(TIKTOK_CREATOR);
  const seen = new Set<string>();
  const handles: string[] = [];
  for (const row of rows) {
    const handle = normalizeCreatorHandle(row.external_id);
    if (handle === null || seen.has(handle)) {
      continue;
    }
    seen.add(handle);
    handles.push(handle);
  }
  handles.sort();
  return handles;
}

export async function runIngest(deps: IngestDeps): Promise<IngestResult> {
  const now = deps.now ?? new Date();
  const createdAt = now.toISOString();
  const summaryModel = deps.summaryModel ?? FAKE_SUMMARY_MODEL;
  const handles = listDistinctTiktokHandles(deps.db);
  const newItemIds: string[] = [];
  const delayedHandles: string[] = [];
  const descriptions = new Map<string, string | null>();

  for (const handle of handles) {
    const latest = await deps.clip.getLatest({ handle });
    if (!latest.ok) {
      delayedHandles.push(handle);
      continue;
    }
    for (const video of latest.data.videos) {
      descriptions.set(video.videoId, video.description);
      const inserted = insertNewItem(deps.db, video, createdAt);
      if (inserted !== null) {
        newItemIds.push(inserted);
      }
    }
  }

  const pending = deps.db
    .prepare<[string], ItemRow>(
      `SELECT id, external_item_id, url, transcript_or_body
       FROM items
       WHERE type = ? AND summary IS NULL
       ORDER BY published_at ASC, id ASC`,
    )
    .all(TIKTOK_CREATOR);

  const summarizedItemIds: string[] = [];
  const delayedItemIds: string[] = [];

  for (const item of pending) {
    const transcript = await deps.clip.getTranscript({
      videoId: item.external_item_id,
      url: item.url,
    });
    if (!transcript.ok) {
      if (transcript.code === "no_transcript") {
        const description =
          descriptions.get(item.external_item_id) ?? item.transcript_or_body;
        if (
          writeSummaryOnce(deps.db, {
            id: item.id,
            transcriptOrBody: description,
            summary: summaryFromDescription(description),
            summaryModel: NO_TRANSCRIPT_MODEL,
          })
        ) {
          summarizedItemIds.push(item.id);
        }
        continue;
      }
      if (shouldDelay(transcript.code)) {
        delayedItemIds.push(item.id);
      }
      continue;
    }

    const body = joinCues(transcript.data.transcript);
    if (body === "") {
      const description =
        transcript.data.metadata.description ??
        descriptions.get(item.external_item_id) ??
        item.transcript_or_body;
      if (
        writeSummaryOnce(deps.db, {
          id: item.id,
          transcriptOrBody: description,
          summary: summaryFromDescription(description),
          summaryModel: NO_TRANSCRIPT_MODEL,
        })
      ) {
        summarizedItemIds.push(item.id);
      }
      continue;
    }

    const summary = await deps.summary.summarize(body);
    if (
      writeSummaryOnce(deps.db, {
        id: item.id,
        transcriptOrBody: body,
        summary,
        summaryModel,
      })
    ) {
      summarizedItemIds.push(item.id);
    }
  }

  return {
    handlesPolled: handles,
    newItemIds,
    summarizedItemIds,
    delayedHandles,
    delayedItemIds,
    partial: delayedHandles.length > 0 || delayedItemIds.length > 0,
  };
}

function insertNewItem(
  db: DailyBriefDb,
  video: ClipCreatorVideo,
  createdAt: string,
): string | null {
  const id = itemId(TIKTOK_CREATOR, video.videoId);
  const title =
    nonempty(video.title) ?? nonempty(video.description) ?? video.videoId;
  const publishedAt = nonempty(video.createTime) ?? createdAt;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO items (
         id, type, external_item_id, url, title, published_at,
         transcript_or_body, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      TIKTOK_CREATOR,
      video.videoId,
      video.url,
      title,
      publishedAt,
      video.description,
      createdAt,
    );
  return result.changes === 1 ? id : null;
}

function writeSummaryOnce(
  db: DailyBriefDb,
  args: {
    id: string;
    transcriptOrBody: string | null | undefined;
    summary: string;
    summaryModel: string;
  },
): boolean {
  const result = db
    .prepare(
      `UPDATE items
       SET transcript_or_body = ?, summary = ?, summary_model = ?
       WHERE id = ? AND summary IS NULL`,
    )
    .run(args.transcriptOrBody ?? null, args.summary, args.summaryModel, args.id);
  return result.changes === 1;
}

function shouldDelay(code: ClipErrorCode): boolean {
  return (
    code === "clip_down" ||
    code === "upstream_blocked" ||
    code === "rate_limited" ||
    code === "internal"
  );
}

function nonempty(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
