import { randomBytes } from "node:crypto";
import type { DailyBriefDb } from "../db.js";
import { SEND_HOUR, type Plan, type User } from "../types.js";

type UserRow = {
  id: string;
  email: string;
  timezone: string;
  plan: Plan;
  send_hour: number;
};

export function newUserId(): string {
  return `usr_${randomBytes(16).toString("hex")}`;
}

export function mapUser(row: UserRow): User {
  if (row.send_hour !== SEND_HOUR) {
    throw new Error(`users.send_hour must be ${SEND_HOUR}`);
  }
  return {
    id: row.id,
    email: row.email,
    timezone: row.timezone,
    plan: row.plan,
    sendHour: SEND_HOUR,
  };
}

export function findUserById(db: DailyBriefDb, id: string): User | null {
  const row = db
    .prepare<[{ id: string }], UserRow>(
      "SELECT id, email, timezone, plan, send_hour FROM users WHERE id = @id",
    )
    .get({ id });
  return row === undefined ? null : mapUser(row);
}

export type UserStripe = {
  customerId: string | null;
  subscriptionId: string | null;
};

type StripeRow = {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

export function findUserStripe(db: DailyBriefDb, id: string): UserStripe | null {
  const row = db
    .prepare<[{ id: string }], StripeRow>(
      `SELECT stripe_customer_id, stripe_subscription_id
       FROM users WHERE id = @id`,
    )
    .get({ id });
  if (row === undefined) {
    return null;
  }
  return {
    customerId: row.stripe_customer_id,
    subscriptionId: row.stripe_subscription_id,
  };
}

export function setUserPlan(
  db: DailyBriefDb,
  userId: string,
  plan: Plan,
  stripe?: { customerId?: string | null; subscriptionId?: string | null },
): boolean {
  if (findUserById(db, userId) === null) {
    return false;
  }
  if (stripe === undefined) {
    db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(plan, userId);
    return true;
  }
  const current = findUserStripe(db, userId);
  if (current === null) {
    return false;
  }
  const customerId =
    stripe.customerId === undefined ? current.customerId : stripe.customerId;
  const subscriptionId =
    stripe.subscriptionId === undefined
      ? current.subscriptionId
      : stripe.subscriptionId;
  db.prepare(
    `UPDATE users
     SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?
     WHERE id = ?`,
  ).run(plan, customerId, subscriptionId, userId);
  return true;
}

export function findOrCreateUser(
  db: DailyBriefDb,
  email: string,
  now: Date,
): User {
  const select = db.prepare<[{ email: string }], UserRow>(
    "SELECT id, email, timezone, plan, send_hour FROM users WHERE email = @email",
  );
  const existing = select.get({ email });
  if (existing !== undefined) {
    return mapUser(existing);
  }
  const id = newUserId();
  try {
    db.prepare(
      "INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)",
    ).run(id, email, now.toISOString());
  } catch (err) {
    const raced = select.get({ email });
    if (raced !== undefined) {
      return mapUser(raced);
    }
    throw err;
  }
  const created = select.get({ email });
  if (created === undefined) {
    throw new Error("user insert did not persist");
  }
  return mapUser(created);
}

export function unsubscribeUser(
  db: DailyBriefDb,
  userId: string,
  now: Date,
): "missing" | "unsubscribed" | "already" {
  const row = db
    .prepare<[{ id: string }], { unsubscribed_at: string | null }>(
      "SELECT unsubscribed_at FROM users WHERE id = @id",
    )
    .get({ id: userId });
  if (row === undefined) {
    return "missing";
  }
  if (row.unsubscribed_at !== null) {
    return "already";
  }
  db.prepare("UPDATE users SET unsubscribed_at = ? WHERE id = ?").run(
    now.toISOString(),
    userId,
  );
  return "unsubscribed";
}

export function consumeMagicLinkJti(
  db: DailyBriefDb,
  jti: string,
  now: Date,
): boolean {
  try {
    db.prepare(
      "INSERT INTO auth_consumed_jti (jti, consumed_at) VALUES (?, ?)",
    ).run(jti, now.toISOString());
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint/i.test(message)) {
      return false;
    }
    throw err;
  }
}
