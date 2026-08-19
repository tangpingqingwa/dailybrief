import type { FastifyPluginAsync } from "fastify";
import { loadSessionUser, type SessionOptions } from "../../auth/session.js";
import { findUserStripe } from "../../auth/users.js";
import { applyStripeEvent } from "../../billing/apply.js";
import {
  PLAN_PRICES_CENTS,
  PLAN_PRICES_USD,
  SOURCE_CAPS,
  isPaidPlan,
  sourceCapForPlan,
} from "../../billing/plans.js";
import type { StripePort } from "../../billing/port.js";
import { StripeUnavailableError } from "../../billing/stripe.js";
import { countSources } from "../../sources.js";

export const BILLING_PATH = "/app/billing" as const;
export const CHECKOUT_PATH = "/app/billing/checkout" as const;
export const PORTAL_PATH = "/app/billing/portal" as const;
export const WEBHOOK_PATH = "/billing/webhook" as const;

export type BillingPluginOptions = SessionOptions & {
  stripe: StripePort;
  publicBaseUrl: string;
};

type ErrorBody = { error: string };

export const billingRoutes: FastifyPluginAsync<BillingPluginOptions> = async (
  app,
  options,
) => {
  app.get(BILLING_PATH, async (request, reply) => {
    const user = loadSessionUser(request, app.db, options);
    if (user === null) {
      return reply.code(401).send({ error: "unauthorized" } satisfies ErrorBody);
    }
    const sourceCount = countSources(app.db, user.id);
    const stripe = findUserStripe(app.db, user.id);
    return {
      plan: user.plan,
      sourceCount,
      sourceCap: sourceCapForPlan(user.plan),
      prices: {
        starter: { usd: PLAN_PRICES_USD.starter, cents: PLAN_PRICES_CENTS.starter },
        pro: { usd: PLAN_PRICES_USD.pro, cents: PLAN_PRICES_CENTS.pro },
      },
      caps: { ...SOURCE_CAPS },
      stripeCustomerId: stripe?.customerId ?? null,
    };
  });

  app.post<{ Body: { plan?: unknown } }>(CHECKOUT_PATH, async (request, reply) => {
    const user = loadSessionUser(request, app.db, options);
    if (user === null) {
      return reply.code(401).send({ error: "unauthorized" } satisfies ErrorBody);
    }
    const plan =
      request.body !== null && typeof request.body === "object"
        ? request.body.plan
        : undefined;
    if (!isPaidPlan(plan)) {
      return reply.code(400).send({ error: "invalid_plan" } satisfies ErrorBody);
    }
    try {
      const session = await options.stripe.createCheckoutSession({
        userId: user.id,
        email: user.email,
        plan,
        successUrl: `${options.publicBaseUrl}${BILLING_PATH}?ok=1`,
        cancelUrl: `${options.publicBaseUrl}${BILLING_PATH}?canceled=1`,
      });
      return reply.code(200).send({
        url: session.url,
        sessionId: session.id,
        plan: session.plan,
        amountCents: session.amountCents,
        currency: session.currency,
      });
    } catch (err) {
      if (err instanceof StripeUnavailableError) {
        return reply
          .code(503)
          .send({ error: "billing_unavailable" } satisfies ErrorBody);
      }
      throw err;
    }
  });

  app.post(PORTAL_PATH, async (request, reply) => {
    const user = loadSessionUser(request, app.db, options);
    if (user === null) {
      return reply.code(401).send({ error: "unauthorized" } satisfies ErrorBody);
    }
    const stripe = findUserStripe(app.db, user.id);
    if (stripe === null || stripe.customerId === null) {
      return reply.code(400).send({ error: "no_customer" } satisfies ErrorBody);
    }
    try {
      const session = await options.stripe.createPortalSession({
        userId: user.id,
        returnUrl: `${options.publicBaseUrl}${BILLING_PATH}`,
      });
      return reply.code(200).send({ url: session.url, sessionId: session.id });
    } catch (err) {
      if (err instanceof StripeUnavailableError) {
        return reply
          .code(503)
          .send({ error: "billing_unavailable" } satisfies ErrorBody);
      }
      throw err;
    }
  });

  app.post(WEBHOOK_PATH, async (request, reply) => {
    const signature = headerValue(request.headers["stripe-signature"]);
    const event = options.stripe.constructEvent(request.body, signature);
    if (event === null) {
      return reply.code(400).send({ error: "invalid_signature" } satisfies ErrorBody);
    }
    const applied = applyStripeEvent(app.db, event, options.now());
    if (!applied.ok) {
      return reply.code(400).send({ error: applied.error } satisfies ErrorBody);
    }
    return { ok: true, plan: applied.plan, replayed: applied.replayed };
  });
};

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
