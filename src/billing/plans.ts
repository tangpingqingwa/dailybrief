import type { Plan } from "../types.js";

export type PaidPlan = Exclude<Plan, "trial">;

export const PAID_PLANS: readonly PaidPlan[] = ["starter", "pro"];

/** Monthly USD prices (SPEC §4). */
export const PLAN_PRICES_USD = {
  starter: 9,
  pro: 19,
} as const satisfies Record<PaidPlan, number>;

export const PLAN_PRICES_CENTS = {
  starter: 900,
  pro: 1900,
} as const satisfies Record<PaidPlan, number>;

/** Hard source caps (SPEC §4, §10). */
export const SOURCE_CAPS = {
  trial: 3,
  starter: 5,
  pro: 25,
} as const satisfies Record<Plan, number>;

export function isPaidPlan(value: unknown): value is PaidPlan {
  return value === "starter" || value === "pro";
}

export function sourceCapForPlan(plan: Plan): number {
  return SOURCE_CAPS[plan];
}

export function priceUsdForPlan(plan: PaidPlan): number {
  return PLAN_PRICES_USD[plan];
}

export function priceCentsForPlan(plan: PaidPlan): number {
  return PLAN_PRICES_CENTS[plan];
}
