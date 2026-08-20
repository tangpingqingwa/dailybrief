import { createHmac, timingSafeEqual } from "node:crypto";
import { liveStripeEnabled } from "../config.js";
import { PLAN_PRICES_CENTS, isPaidPlan, type PaidPlan } from "./plans.js";
import type {
  CheckoutSession,
  CreateCheckoutArgs,
  CreatePortalArgs,
  PortalSession,
  StripeEvent,
  StripePort,
} from "./port.js";

export const STRIPE_API_BASE = "https://api.stripe.com";
export const STRIPE_TIMEOUT_MS = 8_000;

export class StripeUnavailableError extends Error {
  readonly code = "billing_unavailable" as const;

  constructor(message = "live Stripe is not enabled; inject StripePort") {
    super(message);
    this.name = "StripeUnavailableError";
  }
}

export class StripeRequestError extends Error {
  readonly code = "billing_request_failed" as const;
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "StripeRequestError";
    this.status = status;
  }
}

export type StripeFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type StripeClientConfig = {
  secretKey?: string;
  webhookSecret?: string;
  priceIds?: Partial<Record<PaidPlan, string>>;
  fetch?: StripeFetch;
  timeoutMs?: number;
};

export type CreateStripeOptions = {
  env?: NodeJS.ProcessEnv;
  fetch?: StripeFetch;
};

export type ResolvedStripeAdapter =
  | { kind: "unavailable"; reason: string }
  | {
      kind: "live";
      config: {
        secretKey: string;
        webhookSecret: string;
        priceIds: Record<PaidPlan, string>;
      };
    };

/** Fail-closed unless STRIPE_LIVE=1 plus secrets. Tests inject `createFakeStripe()`. */
export function createStripeClient(
  config: StripeClientConfig = {},
  options: CreateStripeOptions = {},
): StripePort {
  const env = options.env ?? process.env;
  const resolved = resolveStripeAdapter(env, config);
  if (resolved.kind === "unavailable") {
    return createUnavailableStripe(resolved.reason);
  }
  return createLiveStripe({
    ...resolved.config,
    ...(config.fetch !== undefined
      ? { fetch: config.fetch }
      : options.fetch !== undefined
        ? { fetch: options.fetch }
        : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });
}

export function resolveStripeAdapter(
  env: NodeJS.ProcessEnv = process.env,
  override: StripeClientConfig = {},
): ResolvedStripeAdapter {
  if (!liveStripeEnabled(env)) {
    return { kind: "unavailable", reason: "STRIPE_LIVE is not enabled" };
  }
  const secretKey = nonEmpty(override.secretKey) ?? nonEmpty(env.STRIPE_SECRET_KEY);
  if (secretKey === null) {
    return { kind: "unavailable", reason: "STRIPE_SECRET_KEY is required" };
  }
  const webhookSecret =
    nonEmpty(override.webhookSecret) ?? nonEmpty(env.STRIPE_WEBHOOK_SECRET);
  if (webhookSecret === null) {
    return { kind: "unavailable", reason: "STRIPE_WEBHOOK_SECRET is required" };
  }
  const starter =
    nonEmpty(override.priceIds?.starter) ?? nonEmpty(env.STRIPE_PRICE_STARTER);
  const pro = nonEmpty(override.priceIds?.pro) ?? nonEmpty(env.STRIPE_PRICE_PRO);
  if (starter === null || pro === null) {
    return {
      kind: "unavailable",
      reason: "STRIPE_PRICE_STARTER and STRIPE_PRICE_PRO are required",
    };
  }
  return {
    kind: "live",
    config: {
      secretKey,
      webhookSecret,
      priceIds: { starter, pro },
    },
  };
}

export function createUnavailableStripe(reason?: string): StripePort {
  const message =
    reason === undefined
      ? "live Stripe is not enabled; inject StripePort"
      : `live Stripe is not enabled: ${reason}`;
  return {
    async createCheckoutSession() {
      throw new StripeUnavailableError(message);
    },
    async createPortalSession() {
      throw new StripeUnavailableError(message);
    },
    constructEvent() {
      return null;
    },
  };
}

export function createLiveStripe(config: {
  secretKey: string;
  webhookSecret: string;
  priceIds: Record<PaidPlan, string>;
  fetch?: StripeFetch;
  timeoutMs?: number;
}): StripePort {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = config.timeoutMs ?? STRIPE_TIMEOUT_MS;
  const priceToPlan = new Map<string, PaidPlan>(
    (Object.entries(config.priceIds) as Array<[PaidPlan, string]>).map(
      ([plan, priceId]) => [priceId, plan],
    ),
  );

  const request = async (
    method: "GET" | "POST",
    path: string,
    form?: Record<string, string>,
  ): Promise<unknown> => {
    const url = `${STRIPE_API_BASE}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.secretKey}`,
          ...(form === undefined
            ? {}
            : { "content-type": "application/x-www-form-urlencoded" }),
        },
        ...(form === undefined ? {} : { body: encodeForm(form) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new StripeRequestError(requestFailureMessage(err), 0);
    }
    const raw = await response.text();
    let body: unknown = null;
    if (raw !== "") {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        throw new StripeRequestError(
          `Stripe ${path} returned invalid JSON`,
          response.status,
        );
      }
    }
    if (response.status < 200 || response.status >= 300) {
      throw new StripeRequestError(
        `Stripe ${path} failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return body;
  };

  return {
    async createCheckoutSession(args: CreateCheckoutArgs): Promise<CheckoutSession> {
      const priceId = config.priceIds[args.plan];
      const body = asRecord(
        await request("POST", "/v1/checkout/sessions", {
          mode: "subscription",
          success_url: args.successUrl,
          cancel_url: args.cancelUrl,
          customer_email: args.email,
          "line_items[0][price]": priceId,
          "line_items[0][quantity]": "1",
          "metadata[userId]": args.userId,
          "metadata[plan]": args.plan,
          "subscription_data[metadata][userId]": args.userId,
          "subscription_data[metadata][plan]": args.plan,
        }),
      );
      const id = stringField(body, "id");
      const url = stringField(body, "url");
      if (id === null || url === null) {
        throw new StripeRequestError("Stripe checkout session missing id/url");
      }
      return {
        id,
        url,
        userId: args.userId,
        plan: args.plan,
        amountCents: PLAN_PRICES_CENTS[args.plan],
        currency: "usd",
      };
    },
    async createPortalSession(args: CreatePortalArgs): Promise<PortalSession> {
      const list = asRecord(
        await request(
          "GET",
          `/v1/customers/search?${new URLSearchParams({
            query: `metadata['userId']:'${args.userId}'`,
            limit: "1",
          }).toString()}`,
        ),
      );
      const first = firstListData(list);
      const customerId = first === null ? null : stringField(first, "id");
      if (customerId === null) {
        throw new StripeRequestError(
          "Stripe customer not found for portal",
          404,
        );
      }
      const body = asRecord(
        await request("POST", "/v1/billing_portal/sessions", {
          customer: customerId,
          return_url: args.returnUrl,
        }),
      );
      const id = stringField(body, "id");
      const url = stringField(body, "url");
      if (id === null || url === null) {
        throw new StripeRequestError("Stripe portal session missing id/url");
      }
      return { id, url, userId: args.userId };
    },
    constructEvent(
      payload: unknown,
      signature: string | undefined,
    ): StripeEvent | null {
      const raw = rawWebhookBody(payload);
      if (raw === null || !verifyStripeSignature(raw, signature, config.webhookSecret)) {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
      return parseLiveStripeEvent(parsed, priceToPlan);
    },
  };
}

export function verifyStripeSignature(
  payload: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (header === undefined || header === "") {
    return false;
  }
  const parts = parseSignatureHeader(header);
  if (parts === null) {
    return false;
  }
  const signed = `${parts.timestamp}.${payload}`;
  const expected = createHmac("sha256", secret).update(signed).digest("hex");
  return timingSafeEqualHex(expected, parts.v1);
}

function parseLiveStripeEvent(
  value: unknown,
  priceToPlan: Map<string, PaidPlan>,
): StripeEvent | null {
  const rec = asRecord(value);
  if (rec === null) {
    return null;
  }
  const id = stringField(rec, "id");
  const type = stringField(rec, "type");
  if (id === null || type === null) {
    return null;
  }
  const object = asRecord(asRecord(rec.data)?.object);
  if (object === null) {
    return null;
  }

  if (type === "checkout.session.completed") {
    const sessionId = stringField(object, "id") ?? id;
    const metadata = asRecord(object.metadata);
    const userId = stringField(metadata, "userId");
    const plan = planFromMetadataOrPrice(metadata, object, priceToPlan);
    const customerId = stringField(object, "customer");
    const subscriptionId = stringField(object, "subscription");
    const amountCents = integerField(object, "amount_total");
    if (
      userId === null ||
      plan === null ||
      customerId === null ||
      subscriptionId === null ||
      amountCents === null
    ) {
      return null;
    }
    return {
      type: "checkout.session.completed",
      id,
      sessionId,
      userId,
      plan,
      customerId,
      subscriptionId,
      amountCents,
    };
  }

  if (type === "customer.subscription.updated") {
    const metadata = asRecord(object.metadata);
    const userId = stringField(metadata, "userId");
    const plan = planFromMetadataOrPrice(metadata, object, priceToPlan);
    const customerId = stringField(object, "customer");
    const subscriptionId = stringField(object, "id");
    const statusRaw = stringField(object, "status");
    const status =
      statusRaw === "canceled" || statusRaw === "unpaid" || statusRaw === "incomplete_expired"
        ? "canceled"
        : "active";
    if (userId === null || plan === null || customerId === null || subscriptionId === null) {
      return null;
    }
    return {
      type: "customer.subscription.updated",
      id,
      userId,
      plan,
      customerId,
      subscriptionId,
      status,
    };
  }

  if (type === "customer.subscription.deleted") {
    const metadata = asRecord(object.metadata);
    const userId = stringField(metadata, "userId");
    const customerId = stringField(object, "customer");
    const subscriptionId = stringField(object, "id");
    if (userId === null || customerId === null || subscriptionId === null) {
      return null;
    }
    return {
      type: "customer.subscription.deleted",
      id,
      userId,
      customerId,
      subscriptionId,
    };
  }

  return null;
}

function planFromMetadataOrPrice(
  metadata: Record<string, unknown> | null,
  object: Record<string, unknown>,
  priceToPlan: Map<string, PaidPlan>,
): PaidPlan | null {
  const fromMeta = metadata === null ? null : metadata.plan;
  if (isPaidPlan(fromMeta)) {
    return fromMeta;
  }
  const items = asRecord(object.items);
  const first = firstListData(items);
  const price = first === null ? null : asRecord(first.price);
  const priceId = price === null ? null : stringField(price, "id");
  if (priceId === null) {
    return null;
  }
  return priceToPlan.get(priceId) ?? null;
}

function parseSignatureHeader(
  header: string,
): { timestamp: string; v1: string } | null {
  let timestamp: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (key === "t") {
      timestamp = value;
    } else if (key === "v1" && v1 === null) {
      v1 = value;
    }
  }
  if (timestamp === null || v1 === null || timestamp === "" || v1 === "") {
    return null;
  }
  return { timestamp, v1 };
}

function timingSafeEqualHex(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function rawWebhookBody(payload: unknown): string | null {
  if (typeof payload === "string") {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString("utf8");
  }
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload).toString("utf8");
  }
  return null;
}

function encodeForm(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, value);
  }
  return params.toString();
}

function requestFailureMessage(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "Stripe request timed out";
  }
  return err instanceof Error ? err.message : "Stripe request failed";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstListData(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (value === null || !Array.isArray(value.data) || value.data.length === 0) {
    return null;
  }
  return asRecord(value.data[0]);
}

function stringField(rec: Record<string, unknown> | null, key: string): string | null {
  if (rec === null) {
    return null;
  }
  const value = rec[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function integerField(rec: Record<string, unknown>, key: string): number | null {
  const value = rec[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
