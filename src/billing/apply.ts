import { setUserPlan } from "../auth/users.js";
import type { DailyBriefDb } from "../db.js";
import type { Plan } from "../types.js";
import { PLAN_PRICES_CENTS } from "./plans.js";
import type { StripeEvent } from "./port.js";

export type ApplyStripeResult =
  | { ok: true; userId: string; plan: Plan; replayed: boolean }
  | { ok: false; error: "missing_user" | "amount_mismatch" };

export function applyStripeEvent(
  db: DailyBriefDb,
  event: StripeEvent,
  now = new Date(),
): ApplyStripeResult {
  if (alreadyApplied(db, event.id)) {
    const userId = event.userId;
    const plan = currentPlan(db, userId);
    if (plan === null) {
      return { ok: false, error: "missing_user" };
    }
    return { ok: true, userId, plan, replayed: true };
  }

  if (event.type === "checkout.session.completed") {
    if (event.amountCents !== PLAN_PRICES_CENTS[event.plan]) {
      return { ok: false, error: "amount_mismatch" };
    }
    const written = writePlan(db, event.userId, event.plan, {
      customerId: event.customerId,
      subscriptionId: event.subscriptionId,
    });
    if (!written.ok) {
      return written;
    }
    recordEvent(db, event, now);
    return { ...written, replayed: false };
  }

  if (event.type === "customer.subscription.updated") {
    const plan = event.status === "canceled" ? "trial" : event.plan;
    const written = writePlan(db, event.userId, plan, {
      customerId: event.customerId,
      subscriptionId: event.status === "canceled" ? null : event.subscriptionId,
    });
    if (!written.ok) {
      return written;
    }
    recordEvent(db, event, now);
    return { ...written, replayed: false };
  }

  const written = writePlan(db, event.userId, "trial", {
    customerId: event.customerId,
    subscriptionId: null,
  });
  if (!written.ok) {
    return written;
  }
  recordEvent(db, event, now);
  return { ...written, replayed: false };
}

function writePlan(
  db: DailyBriefDb,
  userId: string,
  plan: Plan,
  stripe: { customerId?: string | null; subscriptionId?: string | null },
): { ok: true; userId: string; plan: Plan } | { ok: false; error: "missing_user" } {
  const updated = setUserPlan(db, userId, plan, stripe);
  if (!updated) {
    return { ok: false, error: "missing_user" };
  }
  return { ok: true, userId, plan };
}

function alreadyApplied(db: DailyBriefDb, eventId: string): boolean {
  const row = db
    .prepare<[string], { id: string }>("SELECT id FROM stripe_events WHERE id = ?")
    .get(eventId);
  return row !== undefined;
}

function currentPlan(db: DailyBriefDb, userId: string): Plan | null {
  const row = db
    .prepare<[string], { plan: Plan }>("SELECT plan FROM users WHERE id = ?")
    .get(userId);
  return row === undefined ? null : row.plan;
}

function recordEvent(db: DailyBriefDb, event: StripeEvent, now: Date): void {
  db.prepare(
    "INSERT OR IGNORE INTO stripe_events (id, type, applied_at) VALUES (?, ?, ?)",
  ).run(event.id, event.type, now.toISOString());
}
