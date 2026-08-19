import type { StripePort } from "./port.js";

export class StripeUnavailableError extends Error {
  readonly code = "billing_unavailable" as const;

  constructor(message = "live Stripe is not enabled; inject StripePort") {
    super(message);
    this.name = "StripeUnavailableError";
  }
}

export type StripeClientConfig = {
  secretKey?: string;
  webhookSecret?: string;
};

/** Fail-closed adapter. Tests inject `createFakeStripe()`. */
export function createStripeClient(
  _config: StripeClientConfig = {},
): StripePort {
  return {
    async createCheckoutSession() {
      throw new StripeUnavailableError();
    },
    async createPortalSession() {
      throw new StripeUnavailableError();
    },
    constructEvent() {
      return null;
    },
  };
}
