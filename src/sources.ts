import { randomBytes } from "node:crypto";
import { sourceCapForPlan } from "./billing/plans.js";
import {
  normalizeCreatorHandle,
  type ClipClient,
} from "./clients/clip.js";
import type { DailyBriefDb } from "./db.js";
import { TIKTOK_CREATOR } from "./ingest.js";
import type { Plan, Source, SourceType } from "./types.js";

export type AddSourceInput = {
  handle?: unknown;
  url?: unknown;
  type?: unknown;
  label?: unknown;
};

export type AddSourceOk = { ok: true; source: Source };

export type AddSourceErr = {
  ok: false;
  error:
    | "invalid_source"
    | "unsupported_type"
    | "frozen_type"
    | "source_not_found"
    | "clip_down"
    | "source_cap"
    | "source_exists";
  plan?: Plan;
  cap?: number;
  count?: number;
};

export type AddSourceResult = AddSourceOk | AddSourceErr;

export type DeleteSourceResult = "deleted" | "not_found";

type SourceRow = {
  id: string;
  user_id: string;
  type: SourceType;
  external_id: string;
  label: string;
};

export function newSourceId(): string {
  return `src_${randomBytes(16).toString("hex")}`;
}

export function mapSource(row: SourceRow): Source {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    externalId: row.external_id,
    label: row.label,
  };
}

export function listSources(db: DailyBriefDb, userId: string): Source[] {
  return db
    .prepare<[string], SourceRow>(
      `SELECT id, user_id, type, external_id, label
       FROM sources
       WHERE user_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(userId)
    .map(mapSource);
}

export function countSources(db: DailyBriefDb, userId: string): number {
  const row = db
    .prepare<[string], { n: number }>(
      "SELECT COUNT(*) AS n FROM sources WHERE user_id = ?",
    )
    .get(userId);
  return row?.n ?? 0;
}

export function parseTiktokSource(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  if (looksLikeUrl(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    } catch {
      return null;
    }
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "tiktok.com") {
      return null;
    }
    const match = url.pathname.match(/^\/@([^/]+)/);
    if (match === null) {
      return null;
    }
    return normalizeCreatorHandle(match[1]);
  }
  return normalizeCreatorHandle(trimmed);
}

export async function addTiktokSource(
  db: DailyBriefDb,
  args: {
    userId: string;
    plan: Plan;
    input: AddSourceInput;
    clip: ClipClient;
    now: Date;
    freezeNewSources: boolean;
  },
): Promise<AddSourceResult> {
  const type = parseRequestedType(args.input.type);
  if (type === "invalid") {
    return { ok: false, error: "unsupported_type" };
  }
  if (type !== TIKTOK_CREATOR) {
    return {
      ok: false,
      error: args.freezeNewSources ? "frozen_type" : "unsupported_type",
    };
  }

  const raw = firstString(args.input.handle) ?? firstString(args.input.url);
  if (raw === null) {
    return { ok: false, error: "invalid_source" };
  }
  const handle = parseTiktokSource(raw);
  if (handle === null) {
    return { ok: false, error: "invalid_source" };
  }

  const cap = sourceCapForPlan(args.plan);
  const existingCount = countSources(db, args.userId);
  if (existingCount >= cap) {
    return {
      ok: false,
      error: "source_cap",
      plan: args.plan,
      cap,
      count: existingCount,
    };
  }

  const latest = await args.clip.getLatest({ handle });
  if (!latest.ok) {
    if (latest.code === "not_found") {
      return { ok: false, error: "source_not_found" };
    }
    return { ok: false, error: "clip_down" };
  }

  const label = firstString(args.input.label) ?? latest.data.handle ?? handle;
  const createdAt = args.now.toISOString();
  const id = newSourceId();

  try {
    return db.transaction((): AddSourceResult => {
      const count = countSources(db, args.userId);
      if (count >= cap) {
        return {
          ok: false,
          error: "source_cap",
          plan: args.plan,
          cap,
          count,
        };
      }
      db.prepare(
        `INSERT INTO sources (id, user_id, type, external_id, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, args.userId, TIKTOK_CREATOR, handle, label, createdAt);
      return {
        ok: true,
        source: {
          id,
          userId: args.userId,
          type: TIKTOK_CREATOR,
          externalId: handle,
          label,
        },
      };
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint/i.test(message)) {
      return { ok: false, error: "source_exists" };
    }
    throw err;
  }
}

export function deleteSource(
  db: DailyBriefDb,
  userId: string,
  sourceId: string,
): DeleteSourceResult {
  const result = db
    .prepare("DELETE FROM sources WHERE id = ? AND user_id = ?")
    .run(sourceId, userId);
  return result.changes === 1 ? "deleted" : "not_found";
}

function parseRequestedType(value: unknown): SourceType | "invalid" {
  if (value === undefined || value === null || value === "") {
    return TIKTOK_CREATOR;
  }
  if (value === "tiktok_creator") {
    return "tiktok_creator";
  }
  if (
    value === "reddit_sub" ||
    value === "x_account" ||
    value === "ios_reviews"
  ) {
    return value;
  }
  return "invalid";
}

function firstString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function looksLikeUrl(value: string): boolean {
  return (
    value.includes("://") ||
    value.startsWith("www.") ||
    value.startsWith("tiktok.com/") ||
    value.startsWith("vm.tiktok.com/")
  );
}
