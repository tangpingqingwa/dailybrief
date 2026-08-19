import { randomBytes } from "node:crypto";
import { signUnsub } from "./auth/token.js";
import { normalizeCreatorHandle } from "./clients/clip.js";
import type { DailyBriefDb } from "./db.js";
import { renderDailyEmail } from "./email/templates/daily.js";
import type { EmailPort } from "./email/port.js";
import { SEND_HOUR, type Plan } from "./types.js";

export const DEFAULT_TIMEZONE = "America/New_York";

export type SendDeps = {
  db: DailyBriefDb;
  email: EmailPort;
  authSecret: string;
  publicBaseUrl: string;
  now?: Date;
  delayedHandles?: readonly string[];
};

export type SendUserResult = {
  userId: string;
  date: string;
  itemIds: string[];
  partial: boolean;
  sent: boolean;
  skipped: "already_processed" | "unsubscribed" | "empty_trial" | null;
};

export type SendRunResult = {
  attempted: number;
  sent: number;
  skipped: number;
  deliveries: SendUserResult[];
};

type SendUserRow = {
  id: string;
  email: string;
  timezone: string;
  plan: Plan;
  send_hour: number;
  unsubscribed_at: string | null;
};

type SourceRow = {
  type: string;
  external_id: string;
  label: string;
};

type ItemRow = {
  id: string;
  type: string;
  url: string;
  title: string;
  summary: string | null;
  published_at: string;
};

type DeliveryRow = {
  id: string;
  sent_at: string | null;
};

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function resolveTimeZone(timeZone: string): string {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const tz = resolveTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((entry) => entry.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function formatLocalDate(
  parts: Pick<LocalParts, "year" | "month" | "day">,
): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addLocalDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}

export function zonedLocalTimeToUtc(
  date: string,
  hour: number,
  timeZone: string,
  minute = 0,
  second = 0,
): Date {
  const tz = resolveTimeZone(timeZone);
  const [year, month, day] = date.split("-").map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new Error(`invalid local date ${date}`);
  }
  let utc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i += 1) {
    const got = localParts(new Date(utc), tz);
    const gotMs = Date.UTC(
      got.year,
      got.month - 1,
      got.day,
      got.hour,
      got.minute,
      got.second,
    );
    const wantMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const delta = wantMs - gotMs;
    if (delta === 0) {
      return new Date(utc);
    }
    utc += delta;
  }
  return new Date(utc);
}

export function sendWindowUtc(
  localDate: string,
  timeZone: string,
  sendHour: number = SEND_HOUR,
): { start: Date; end: Date } {
  const end = zonedLocalTimeToUtc(localDate, sendHour, timeZone);
  const start = zonedLocalTimeToUtc(addLocalDays(localDate, -1), sendHour, timeZone);
  return { start, end };
}

export function itemInWindow(
  publishedAt: string,
  window: { start: Date; end: Date },
): boolean {
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(published)) {
    return false;
  }
  return published >= window.start.getTime() && published < window.end.getTime();
}

export function dueLocalDate(
  now: Date,
  timeZone: string,
  sendHour: number = SEND_HOUR,
): string {
  const parts = localParts(now, timeZone);
  const today = formatLocalDate(parts);
  if (parts.hour >= sendHour) {
    return today;
  }
  return addLocalDays(today, -1);
}

function localWeekday(localDate: string, timeZone: string): string {
  const noon = zonedLocalTimeToUtc(localDate, 12, timeZone);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: resolveTimeZone(timeZone),
  }).format(noon);
}

function tiktokHandleFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = parsed.pathname.match(/^\/@([^/]+)/);
  if (match === null) {
    return null;
  }
  return normalizeCreatorHandle(match[1]);
}

function newDeliveryId(): string {
  return `del_${randomBytes(16).toString("hex")}`;
}

export async function runDailySend(deps: SendDeps): Promise<SendRunResult> {
  const now = deps.now ?? new Date();
  const users = listSendUsers(deps.db);
  const deliveries: SendUserResult[] = [];
  for (const user of users) {
    const date = dueLocalDate(now, user.timezone, user.send_hour);
    deliveries.push(await sendUserDay(deps, user, date, now));
  }
  return {
    attempted: deliveries.length,
    sent: deliveries.filter((row) => row.sent).length,
    skipped: deliveries.filter((row) => !row.sent).length,
    deliveries,
  };
}

async function sendUserDay(
  deps: SendDeps,
  user: SendUserRow,
  localDate: string,
  now: Date,
): Promise<SendUserResult> {
  if (user.unsubscribed_at !== null) {
    return {
      userId: user.id,
      date: localDate,
      itemIds: [],
      partial: false,
      sent: false,
      skipped: "unsubscribed",
    };
  }

  const existing = getDelivery(deps.db, user.id, localDate);
  if (existing !== null && existing.sent_at !== null) {
    return {
      userId: user.id,
      date: localDate,
      itemIds: [],
      partial: false,
      sent: false,
      skipped: "already_processed",
    };
  }

  const deliveryId = existing?.id ?? insertDelivery(deps.db, user.id, localDate, now);
  const window = sendWindowUtc(localDate, user.timezone, user.send_hour);
  const sources = listUserSources(deps.db, user.id);
  const delayedSet = new Set(
    (deps.delayedHandles ?? [])
      .map((handle) => normalizeCreatorHandle(handle))
      .filter((handle): handle is string => handle !== null),
  );

  const matched = selectWindowItems(deps.db, sources, window);
  const included: typeof matched = [];
  const delayedLabels: string[] = [];
  const seenDelayed = new Set<string>();

  const markDelayed = (label: string): void => {
    if (seenDelayed.has(label)) {
      return;
    }
    seenDelayed.add(label);
    delayedLabels.push(label);
  };

  for (const source of sources) {
    const handle = normalizeCreatorHandle(source.external_id);
    if (handle !== null && delayedSet.has(handle)) {
      markDelayed(source.label || handle);
    }
  }

  for (const item of matched) {
    if (item.summary === null || item.summary === "") {
      markDelayed(item.label);
      continue;
    }
    included.push(item);
  }

  const partial = delayedLabels.length > 0;
  const empty = included.length === 0;
  const shouldSend = !empty || partial || user.plan !== "trial";

  if (shouldSend) {
    const unsubUrl = `${deps.publicBaseUrl}/unsub/${signUnsub(user.id, deps.authSecret)}`;
    const rendered = renderDailyEmail({
      weekday: localWeekday(localDate, user.timezone),
      items: included.map((item) => ({
        sourceLabel: item.label,
        title: item.title,
        summary: item.summary ?? "",
        url: item.url,
      })),
      delayedLabels,
      trial: user.plan === "trial",
      unsubUrl,
      manageUrl: `${deps.publicBaseUrl}/app`,
    });
    await deps.email.send({
      to: user.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
  }

  const itemIds = included.map((item) => item.id);
  markDeliverySent(deps.db, deliveryId, {
    itemIds,
    sentAt: now.toISOString(),
    partial,
  });

  return {
    userId: user.id,
    date: localDate,
    itemIds,
    partial,
    sent: shouldSend,
    skipped: shouldSend ? null : "empty_trial",
  };
}

function listSendUsers(db: DailyBriefDb): SendUserRow[] {
  return db
    .prepare<[], SendUserRow>(
      `SELECT id, email, timezone, plan, send_hour, unsubscribed_at
       FROM users
       ORDER BY id ASC`,
    )
    .all();
}

function listUserSources(db: DailyBriefDb, userId: string): SourceRow[] {
  return db
    .prepare<[string], SourceRow>(
      `SELECT type, external_id, label FROM sources WHERE user_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(userId);
}

function selectWindowItems(
  db: DailyBriefDb,
  sources: SourceRow[],
  window: { start: Date; end: Date },
): Array<ItemRow & { label: string }> {
  if (sources.length === 0) {
    return [];
  }
  const items = db
    .prepare<[], ItemRow>(
      `SELECT id, type, url, title, summary, published_at
       FROM items
       ORDER BY published_at ASC, id ASC`,
    )
    .all();
  const matched: Array<ItemRow & { label: string }> = [];
  for (const item of items) {
    if (!itemInWindow(item.published_at, window)) {
      continue;
    }
    const source = sources.find((row) => sourceOwnsItem(row, item));
    if (source === undefined) {
      continue;
    }
    matched.push({ ...item, label: source.label });
  }
  return matched;
}

function sourceOwnsItem(source: SourceRow, item: ItemRow): boolean {
  if (source.type !== item.type) {
    return false;
  }
  if (source.type !== "tiktok_creator") {
    return false;
  }
  const fromUrl = tiktokHandleFromUrl(item.url);
  const fromSource = normalizeCreatorHandle(source.external_id);
  return fromUrl !== null && fromSource !== null && fromUrl === fromSource;
}

function getDelivery(
  db: DailyBriefDb,
  userId: string,
  localDate: string,
): DeliveryRow | null {
  const row = db
    .prepare<[{ userId: string; localDate: string }], DeliveryRow>(
      `SELECT id, sent_at FROM deliveries
       WHERE user_id = @userId AND local_date = @localDate`,
    )
    .get({ userId, localDate });
  return row === undefined ? null : row;
}

function insertDelivery(
  db: DailyBriefDb,
  userId: string,
  localDate: string,
  now: Date,
): string {
  const existing = getDelivery(db, userId, localDate);
  if (existing !== null) {
    return existing.id;
  }
  const id = newDeliveryId();
  try {
    db.prepare(
      `INSERT INTO deliveries (id, user_id, local_date, item_ids, created_at)
       VALUES (?, ?, ?, '[]', ?)`,
    ).run(id, userId, localDate, now.toISOString());
    return id;
  } catch (err) {
    const raced = getDelivery(db, userId, localDate);
    if (raced !== null) {
      return raced.id;
    }
    throw err;
  }
}

function markDeliverySent(
  db: DailyBriefDb,
  id: string,
  args: { itemIds: string[]; sentAt: string; partial: boolean },
): void {
  db.prepare(
    `UPDATE deliveries
     SET item_ids = ?, sent_at = ?, partial = ?
     WHERE id = ?`,
  ).run(JSON.stringify(args.itemIds), args.sentAt, args.partial ? 1 : 0, id);
}
