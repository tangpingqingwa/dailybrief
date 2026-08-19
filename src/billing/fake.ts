import { randomBytes } from "node:crypto";
import {
  priceCentsForPlan,
  type PaidPlan,
} from "./plans.js";
import type {
  CheckoutSession,
  CreateCheckoutArgs,
  CreatePortalArgs,
  PortalSession,
  StripeEvent,
  StripePort,
} from "./port.js";

export const FAKE_STRIPE_SIGNATURE = "fake-stripe-signature";

export type FakeCheckout = CheckoutSession & {
  email: string;
};

export type FakeStripe = StripePort & {
  checkouts: FakeCheckout[];
  portals: PortalSession[];
  events: StripeEvent[];
  completeCheckout(sessionId: string): StripeEvent | null;
  updateSubscription(
    userId: string,
    plan: PaidPlan,
    status?: "active" | "canceled",
  ): StripeEvent;
  cancelSubscription(userId: string): StripeEvent;
};

export function createFakeStripe(): FakeStripe {
  const checkouts: FakeCheckout[] = [];
  const portals: PortalSession[] = [];
  const events: StripeEvent[] = [];
  const customers = new Map<string, { customerId: string; subscriptionId: string }>();

  const ensureCustomer = (userId: string): { customerId: string; subscriptionId: string } => {
    const existing = customers.get(userId);
    if (existing !== undefined) {
      return existing;
    }
    const created = {
      customerId: `cus_fake_${userId}`,
      subscriptionId: `sub_fake_${randomBytes(8).toString("hex")}`,
    };
    customers.set(userId, created);
    return created;
  };

  return {
    checkouts,
    portals,
    events,
    async createCheckoutSession(args: CreateCheckoutArgs): Promise<CheckoutSession> {
      const id = `cs_test_${randomBytes(8).toString("hex")}`;
      const session: FakeCheckout = {
        id,
        url: `https://billing.dailybrief.test/checkout/${id}`,
        userId: args.userId,
        plan: args.plan,
        amountCents: priceCentsForPlan(args.plan),
        currency: "usd",
        email: args.email,
      };
      checkouts.push(session);
      return {
        id: session.id,
        url: session.url,
        userId: session.userId,
        plan: session.plan,
        amountCents: session.amountCents,
        currency: session.currency,
      };
    },
    async createPortalSession(args: CreatePortalArgs): Promise<PortalSession> {
      const id = `bps_test_${randomBytes(8).toString("hex")}`;
      const session: PortalSession = {
        id,
        url: `https://billing.dailybrief.test/portal/${id}`,
        userId: args.userId,
      };
      portals.push(session);
      return session;
    },
    constructEvent(
      payload: unknown,
      signature: string | undefined,
    ): StripeEvent | null {
      if (signature !== FAKE_STRIPE_SIGNATURE) {
        return null;
      }
      const body = unwrapPayload(payload);
      return parseStripeEvent(body);
    },
    completeCheckout(sessionId: string): StripeEvent | null {
      const session = checkouts.find((row) => row.id === sessionId);
      if (session === undefined) {
        return null;
      }
      const ids = ensureCustomer(session.userId);
      const event: StripeEvent = {
        type: "checkout.session.completed",
        id: newEventId(),
        sessionId: session.id,
        userId: session.userId,
        plan: session.plan,
        customerId: ids.customerId,
        subscriptionId: ids.subscriptionId,
        amountCents: session.amountCents,
      };
      events.push(event);
      return event;
    },
    updateSubscription(
      userId: string,
      plan: PaidPlan,
      status: "active" | "canceled" = "active",
    ): StripeEvent {
      const ids = ensureCustomer(userId);
      const event: StripeEvent = {
        type: "customer.subscription.updated",
        id: newEventId(),
        userId,
        plan,
        customerId: ids.customerId,
        subscriptionId: ids.subscriptionId,
        status,
      };
      events.push(event);
      return event;
    },
    cancelSubscription(userId: string): StripeEvent {
      const ids = ensureCustomer(userId);
      const event: StripeEvent = {
        type: "customer.subscription.deleted",
        id: newEventId(),
        userId,
        customerId: ids.customerId,
        subscriptionId: ids.subscriptionId,
      };
      events.push(event);
      return event;
    },
  };
}

function newEventId(): string {
  return `evt_fake_${randomBytes(8).toString("hex")}`;
}

function unwrapPayload(payload: unknown): unknown {
  if (typeof payload !== "string") {
    return payload;
  }
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

function parseStripeEvent(value: unknown): StripeEvent | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== "string" || rec.id === "") {
    return null;
  }
  if (typeof rec.userId !== "string" || rec.userId === "") {
    return null;
  }
  if (rec.type === "checkout.session.completed") {
    if (rec.plan !== "starter" && rec.plan !== "pro") {
      return null;
    }
    if (typeof rec.sessionId !== "string" || rec.sessionId === "") {
      return null;
    }
    if (typeof rec.customerId !== "string" || rec.customerId === "") {
      return null;
    }
    if (typeof rec.subscriptionId !== "string" || rec.subscriptionId === "") {
      return null;
    }
    if (typeof rec.amountCents !== "number" || !Number.isInteger(rec.amountCents)) {
      return null;
    }
    return {
      type: "checkout.session.completed",
      id: rec.id,
      sessionId: rec.sessionId,
      userId: rec.userId,
      plan: rec.plan,
      customerId: rec.customerId,
      subscriptionId: rec.subscriptionId,
      amountCents: rec.amountCents,
    };
  }
  if (rec.type === "customer.subscription.updated") {
    if (rec.plan !== "starter" && rec.plan !== "pro") {
      return null;
    }
    if (rec.status !== "active" && rec.status !== "canceled") {
      return null;
    }
    if (typeof rec.customerId !== "string" || rec.customerId === "") {
      return null;
    }
    if (typeof rec.subscriptionId !== "string" || rec.subscriptionId === "") {
      return null;
    }
    return {
      type: "customer.subscription.updated",
      id: rec.id,
      userId: rec.userId,
      plan: rec.plan,
      customerId: rec.customerId,
      subscriptionId: rec.subscriptionId,
      status: rec.status,
    };
  }
  if (rec.type === "customer.subscription.deleted") {
    if (typeof rec.customerId !== "string" || rec.customerId === "") {
      return null;
    }
    if (typeof rec.subscriptionId !== "string" || rec.subscriptionId === "") {
      return null;
    }
    return {
      type: "customer.subscription.deleted",
      id: rec.id,
      userId: rec.userId,
      customerId: rec.customerId,
      subscriptionId: rec.subscriptionId,
    };
  }
  return null;
}
