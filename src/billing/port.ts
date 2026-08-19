import type { PaidPlan } from "./plans.js";

export type CheckoutSession = {
  id: string;
  url: string;
  userId: string;
  plan: PaidPlan;
  amountCents: number;
  currency: "usd";
};

export type PortalSession = {
  id: string;
  url: string;
  userId: string;
};

export type StripeEvent =
  | {
      type: "checkout.session.completed";
      id: string;
      sessionId: string;
      userId: string;
      plan: PaidPlan;
      customerId: string;
      subscriptionId: string;
      amountCents: number;
    }
  | {
      type: "customer.subscription.updated";
      id: string;
      userId: string;
      plan: PaidPlan;
      customerId: string;
      subscriptionId: string;
      status: "active" | "canceled";
    }
  | {
      type: "customer.subscription.deleted";
      id: string;
      userId: string;
      customerId: string;
      subscriptionId: string;
    };

export type CreateCheckoutArgs = {
  userId: string;
  email: string;
  plan: PaidPlan;
  successUrl: string;
  cancelUrl: string;
};

export type CreatePortalArgs = {
  userId: string;
  returnUrl: string;
};

export type StripePort = {
  createCheckoutSession(args: CreateCheckoutArgs): Promise<CheckoutSession>;
  createPortalSession(args: CreatePortalArgs): Promise<PortalSession>;
  constructEvent(
    payload: unknown,
    signature: string | undefined,
  ): StripeEvent | null;
};
