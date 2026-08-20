import { readEmailSink } from "./email/file.js";
import type { EmailMessage } from "./email/port.js";
import { runIngest, type IngestResult } from "./ingest.js";
import {
  dueLocalDate,
  runDailySend,
  sendWindowUtc,
  type SendRunResult,
} from "./send.js";
import { addTiktokSource } from "./sources.js";
import { createFakeSummary } from "./summary/fake.js";
import type { ClipClient } from "./clients/clip.js";
import type { DailyBriefDb } from "./db.js";
import type { EmailPort } from "./email/port.js";
import type { Plan } from "./types.js";

export const LIVE_SMOKE_EMAIL = "live-smoke@dailybrief.test";
export const LIVE_SMOKE_HANDLE_DEFAULT = "khaby.lame";

export type LiveSmokeVerdict = "PASS" | "PASS-ERROR" | "FAIL" | "BLOCKED-SECRET";

export type LiveSmokeCase = {
  name: string;
  verdict: LiveSmokeVerdict;
  detail: string;
};

export type LiveSmokeResult = {
  cases: LiveSmokeCase[];
  ingest: IngestResult | null;
  send: SendRunResult | null;
  message: EmailMessage | null;
  blockedSecret: string | null;
};

export type LiveSmokeDeps = {
  db: DailyBriefDb;
  clip: ClipClient;
  email: EmailPort;
  authSecret: string;
  publicBaseUrl: string;
  handle: string;
  now?: Date;
  readSent?: () => EmailMessage[] | null;
};

type ItemRow = {
  id: string;
  type: string;
  external_item_id: string;
  url: string;
  title: string;
  published_at: string;
  summary: string | null;
};

export function missingClipKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.CLIPAPI_KEY;
  if (key === undefined || key.trim() === "") {
    return "CLIPAPI_KEY";
  }
  return null;
}

export function missingMailVendorSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.EMAIL_SINK === "file" && (env.EMAIL_SINK_PATH ?? "").trim() !== "") {
    return null;
  }
  if (env.EMAIL_LIVE !== "1") {
    return "EMAIL_LIVE";
  }
  if (env.EMAIL_PROVIDER === "resend") {
    return (env.RESEND_API_KEY ?? "").trim() === "" ? "RESEND_API_KEY" : null;
  }
  if (env.EMAIL_PROVIDER === "ses") {
    if ((env.AWS_ACCESS_KEY_ID ?? "").trim() === "") {
      return "AWS_ACCESS_KEY_ID";
    }
    if ((env.AWS_SECRET_ACCESS_KEY ?? "").trim() === "") {
      return "AWS_SECRET_ACCESS_KEY";
    }
    return null;
  }
  return "EMAIL_PROVIDER";
}

export function seedLiveSmokeUser(
  db: DailyBriefDb,
  args: {
    email?: string;
    plan?: Plan;
    timezone?: string;
    now?: Date;
  } = {},
): { id: string; email: string } {
  const email = args.email ?? LIVE_SMOKE_EMAIL;
  const now = (args.now ?? new Date()).toISOString();
  const existing = db
    .prepare<[string], { id: string }>("SELECT id FROM users WHERE email = ?")
    .get(email);
  if (existing !== undefined) {
    if (args.plan !== undefined) {
      db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(args.plan, existing.id);
    }
    return { id: existing.id, email };
  }
  const id = "usr_live_smoke";
  db.prepare(
    `INSERT INTO users (id, email, timezone, plan, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, email, args.timezone ?? "America/New_York", args.plan ?? "starter", now);
  return { id, email };
}

/** Move one summarized item into the due send window so a real old clip still mails. */
export function placeItemInDueWindow(
  db: DailyBriefDb,
  now: Date,
  timezone: string,
): ItemRow | null {
  const date = dueLocalDate(now, timezone);
  const window = sendWindowUtc(date, timezone);
  const mid = new Date((window.start.getTime() + window.end.getTime()) / 2);
  const row = db
    .prepare<[], ItemRow>(
      `SELECT id, type, external_item_id, url, title, published_at, summary
       FROM items
       WHERE summary IS NOT NULL AND summary != ''
       ORDER BY published_at DESC, id ASC
       LIMIT 1`,
    )
    .get();
  if (row === undefined) {
    return null;
  }
  db.prepare("UPDATE items SET published_at = ? WHERE id = ?").run(
    mid.toISOString(),
    row.id,
  );
  return { ...row, published_at: mid.toISOString() };
}

export function readSentFile(path: string): EmailMessage[] {
  return readEmailSink(path);
}

export async function runLiveSmoke(deps: LiveSmokeDeps): Promise<LiveSmokeResult> {
  const now = deps.now ?? new Date();
  const cases: LiveSmokeCase[] = [];
  const user = seedLiveSmokeUser(deps.db, { now });

  const added = await addTiktokSource(deps.db, {
    userId: user.id,
    plan: "starter",
    input: { handle: deps.handle },
    clip: deps.clip,
    now,
    freezeNewSources: false,
  });
  if (!added.ok && added.error !== "source_exists") {
    const verdict: LiveSmokeVerdict =
      added.error === "source_not_found" || added.error === "clip_down"
        ? "PASS-ERROR"
        : "FAIL";
    cases.push({
      name: "ingest one TikTok via live ClipAPI",
      verdict,
      detail: `add source ${added.error}`,
    });
    cases.push({
      name: "EmailPort receives ingest+send",
      verdict: verdict === "PASS-ERROR" ? "PASS-ERROR" : "FAIL",
      detail: "skipped; source not added",
    });
    return {
      cases,
      ingest: null,
      send: null,
      message: null,
      blockedSecret: null,
    };
  }

  const ingest = await runIngest({
    db: deps.db,
    clip: deps.clip,
    summary: createFakeSummary(),
    now,
  });

  const summarized = ingest.summarizedItemIds.length;
  const delayedOnly =
    ingest.partial && ingest.newItemIds.length === 0 && summarized === 0;
  if (summarized > 0 || ingest.newItemIds.length > 0) {
    cases.push({
      name: "ingest one TikTok via live ClipAPI",
      verdict: "PASS",
      detail: `polled ${ingest.handlesPolled.join(",") || deps.handle}; new=${ingest.newItemIds.length} summarized=${summarized}`,
    });
  } else if (delayedOnly || ingest.delayedHandles.includes(deps.handle)) {
    cases.push({
      name: "ingest one TikTok via live ClipAPI",
      verdict: "PASS-ERROR",
      detail: `ClipAPI delayed handle=${deps.handle} (no scrape fallback)`,
    });
  } else {
    cases.push({
      name: "ingest one TikTok via live ClipAPI",
      verdict: "FAIL",
      detail: "ingest returned no items and did not mark the handle delayed",
    });
  }

  const placed = placeItemInDueWindow(deps.db, now, "America/New_York");
  const send = await runDailySend({
    db: deps.db,
    email: deps.email,
    authSecret: deps.authSecret,
    publicBaseUrl: deps.publicBaseUrl,
    now,
    delayedHandles: ingest.delayedHandles,
  });

  const sentMessages = deps.readSent?.() ?? null;
  const last =
    sentMessages !== null && sentMessages.length > 0
      ? sentMessages[sentMessages.length - 1]
      : null;
  const delivery = send.deliveries.find((row) => row.userId === user.id) ?? null;

  if (last !== undefined && last !== null && send.sent > 0) {
    const hasUnsub = /\/unsub\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(last.text);
    const hasItem =
      placed !== null &&
      (last.text.includes(placed.title) || last.text.includes(placed.url));
    const emptyOk = placed === null && last.text.includes("Nothing new yesterday");
    if (hasUnsub && (hasItem || emptyOk || delivery?.partial === true)) {
      cases.push({
        name: "EmailPort receives ingest+send",
        verdict: "PASS",
        detail: `to=${last.to} subject=${last.subject} items=${delivery?.itemIds.length ?? 0}`,
      });
    } else {
      cases.push({
        name: "EmailPort receives ingest+send",
        verdict: "FAIL",
        detail: "sent mail missing unsub token or item body",
      });
    }
  } else if (delivery?.partial === true && send.sent === 0) {
    cases.push({
      name: "EmailPort receives ingest+send",
      verdict: "PASS-ERROR",
      detail: "partial delivery recorded; no mail body",
    });
  } else {
    cases.push({
      name: "EmailPort receives ingest+send",
      verdict: "FAIL",
      detail: `sent=${send.sent} deliveries=${send.deliveries.length}`,
    });
  }

  return {
    cases,
    ingest,
    send,
    message: last ?? null,
    blockedSecret: null,
  };
}
