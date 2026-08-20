import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";
import { APP_PATH, MAGIC_LINK_PATH, VERIFY_PATH } from "../src/auth/routes.js";
import { applyStripeEvent } from "../src/billing/apply.js";
import {
  createFakeStripe,
  FAKE_STRIPE_SIGNATURE,
} from "../src/billing/fake.js";
import {
  PLAN_PRICES_CENTS,
  PLAN_PRICES_USD,
  SOURCE_CAPS,
} from "../src/billing/plans.js";
import {
  createStripeClient,
  resolveStripeAdapter,
  STRIPE_API_BASE,
  verifyStripeSignature,
} from "../src/billing/stripe.js";
import { openDatabase } from "../src/db.js";
import { createFakeEmail, extractMagicLinkToken } from "../src/email/fake.js";
import {
  BILLING_PATH,
  CHECKOUT_PATH,
  PORTAL_PATH,
  WEBHOOK_PATH,
} from "../src/http/routes/billing.js";

const SECRET = "test-auth-secret-16";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const PUBLIC_BASE = "http://dailybrief.test";

function cookieHeader(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(first, "expected Set-Cookie");
  const pair = first.split(";", 1)[0];
  assert.ok(pair.includes("="), "expected name=value cookie");
  return pair;
}

async function signIn(
  app: Awaited<ReturnType<typeof buildApp>>,
  email: ReturnType<typeof createFakeEmail>,
  address: string,
): Promise<string> {
  const sent = await app.inject({
    method: "POST",
    url: MAGIC_LINK_PATH,
    payload: { email: address },
  });
  assert.equal(sent.statusCode, 202);
  const token = extractMagicLinkToken(email.sent[email.sent.length - 1].text);
  const verify = await app.inject({
    method: "GET",
    url: `${VERIFY_PATH}?token=${token}`,
  });
  assert.equal(verify.statusCode, 302);
  return cookieHeader(verify.headers["set-cookie"]);
}

test("plans are $9 starter / $19 pro with 5 / 25 source caps", () => {
  assert.equal(PLAN_PRICES_USD.starter, 9);
  assert.equal(PLAN_PRICES_USD.pro, 19);
  assert.equal(PLAN_PRICES_CENTS.starter, 900);
  assert.equal(PLAN_PRICES_CENTS.pro, 1900);
  assert.equal(SOURCE_CAPS.trial, 3);
  assert.equal(SOURCE_CAPS.starter, 5);
  assert.equal(SOURCE_CAPS.pro, 25);
});

test("createStripeClient never talks to Stripe and fails closed", async () => {
  let calls = 0;
  const fetchImpl = async (): Promise<Response> => {
    calls += 1;
    throw new Error("network must not run");
  };
  const stripe = createStripeClient(
    { secretKey: "sk_test_should_not_matter", fetch: fetchImpl },
    { env: {} },
  );
  await assert.rejects(stripe.createCheckoutSession({
    userId: "usr_1",
    email: "a@example.com",
    plan: "starter",
    successUrl: "http://x/ok",
    cancelUrl: "http://x/no",
  }), /live Stripe is not enabled/);
  assert.equal(stripe.constructEvent({ type: "checkout.session.completed" }, "sig"), null);
  assert.equal(calls, 0);
  assert.equal(resolveStripeAdapter({ STRIPE_LIVE: "true" }).kind, "unavailable");
  assert.equal(resolveStripeAdapter({ STRIPE_LIVE: "1" }).kind, "unavailable");
  assert.equal(
    resolveStripeAdapter({
      STRIPE_LIVE: "1",
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      EMAIL_FIXTURE_ONLY: "1",
    }).kind,
    "unavailable",
  );
});

const LIVE_STRIPE_ENV = {
  STRIPE_LIVE: "1",
  STRIPE_SECRET_KEY: "sk_test_live",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_STARTER: "price_starter",
  STRIPE_PRICE_PRO: "price_pro",
} satisfies NodeJS.ProcessEnv;

type Captured = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

function captureFetch(
  status: number,
  json: unknown,
  onCall?: (req: Captured) => void,
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    onCall?.({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

test("STRIPE_LIVE=1 uses injected fetch and never hits api.stripe.com from tests", async () => {
  const seen: Captured[] = [];
  const stripe = createStripeClient(
    {
      fetch: captureFetch(
        200,
        { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" },
        (req) => seen.push(req),
      ),
    },
    { env: LIVE_STRIPE_ENV },
  );
  const session = await stripe.createCheckoutSession({
    userId: "usr_1",
    email: "ada@example.com",
    plan: "starter",
    successUrl: "http://dailybrief.test/ok",
    cancelUrl: "http://dailybrief.test/no",
  });
  assert.equal(session.id, "cs_test_1");
  assert.equal(session.amountCents, 900);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${STRIPE_API_BASE}/v1/checkout/sessions`);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].headers.authorization, "Bearer sk_test_live");
  assert.match(seen[0].body, /price_starter/);
  assert.match(seen[0].body, /usr_1/);
});

test("live Stripe webhook verifies HMAC and maps checkout.session.completed", () => {
  const stripe = createStripeClient({}, { env: LIVE_STRIPE_ENV });
  const payload = JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_1",
        customer: "cus_1",
        subscription: "sub_1",
        amount_total: 900,
        metadata: { userId: "usr_1", plan: "starter" },
      },
    },
  });
  const timestamp = "1700000000";
  const v1 = createHmac("sha256", "whsec_test")
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  const event = stripe.constructEvent(payload, `t=${timestamp},v1=${v1}`);
  assert.deepEqual(event, {
    type: "checkout.session.completed",
    id: "evt_1",
    sessionId: "cs_1",
    userId: "usr_1",
    plan: "starter",
    customerId: "cus_1",
    subscriptionId: "sub_1",
    amountCents: 900,
  });
  assert.equal(stripe.constructEvent(payload, "t=1,v1=deadbeef"), null);
  assert.equal(verifyStripeSignature(payload, undefined, "whsec_test"), false);
});

test("GET /app/billing shows trial cap 3 and $9/$19 prices", async () => {
  const email = createFakeEmail();
  const stripe = createFakeStripe();
  const app = await buildApp({
    email,
    stripe,
    authSecret: SECRET,
    now: () => NOW,
    publicBaseUrl: PUBLIC_BASE,
  });
  after(() => app.close());

  const anon = await app.inject({ method: "GET", url: BILLING_PATH });
  assert.equal(anon.statusCode, 401);

  const cookie = await signIn(app, email, "ada@example.com");
  const billing = await app.inject({
    method: "GET",
    url: BILLING_PATH,
    headers: { cookie },
  });
  assert.equal(billing.statusCode, 200);
  assert.deepEqual(billing.json(), {
    plan: "trial",
    sourceCount: 0,
    sourceCap: 3,
    prices: {
      starter: { usd: 9, cents: 900 },
      pro: { usd: 19, cents: 1900 },
    },
    caps: { trial: 3, starter: 5, pro: 25 },
    stripeCustomerId: null,
  });
});

test("fake Stripe checkout is $9 starter / $19 pro; webhook upgrades plan", async () => {
  const email = createFakeEmail();
  const stripe = createFakeStripe();
  const app = await buildApp({
    email,
    stripe,
    authSecret: SECRET,
    now: () => NOW,
    publicBaseUrl: PUBLIC_BASE,
  });
  after(() => app.close());

  const cookie = await signIn(app, email, "ada@example.com");
  const user = (
    await app.inject({ method: "GET", url: APP_PATH, headers: { cookie } })
  ).json() as { user: { id: string } };

  const badPlan = await app.inject({
    method: "POST",
    url: CHECKOUT_PATH,
    headers: { cookie },
    payload: { plan: "enterprise" },
  });
  assert.equal(badPlan.statusCode, 400);
  assert.deepEqual(badPlan.json(), { error: "invalid_plan" });

  const starter = await app.inject({
    method: "POST",
    url: CHECKOUT_PATH,
    headers: { cookie },
    payload: { plan: "starter" },
  });
  assert.equal(starter.statusCode, 200);
  const starterBody = starter.json() as {
    url: string;
    sessionId: string;
    plan: string;
    amountCents: number;
    currency: string;
  };
  assert.equal(starterBody.plan, "starter");
  assert.equal(starterBody.amountCents, 900);
  assert.equal(starterBody.currency, "usd");
  assert.match(starterBody.url, /^https:\/\/billing\.dailybrief\.test\/checkout\//);
  assert.equal(stripe.checkouts[0]?.userId, user.user.id);

  const event = stripe.completeCheckout(starterBody.sessionId);
  assert.ok(event);
  assert.equal(event.type, "checkout.session.completed");
  if (event.type === "checkout.session.completed") {
    assert.equal(event.amountCents, 900);
  }

  const forged = await app.inject({
    method: "POST",
    url: WEBHOOK_PATH,
    payload: event,
    headers: { "stripe-signature": "wrong" },
  });
  assert.equal(forged.statusCode, 400);

  const hook = await app.inject({
    method: "POST",
    url: WEBHOOK_PATH,
    payload: event,
    headers: { "stripe-signature": FAKE_STRIPE_SIGNATURE },
  });
  assert.equal(hook.statusCode, 200);
  assert.deepEqual(hook.json(), { ok: true, plan: "starter", replayed: false });
  const replay = await app.inject({
    method: "POST",
    url: WEBHOOK_PATH,
    payload: event,
    headers: { "stripe-signature": FAKE_STRIPE_SIGNATURE },
  });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), { ok: true, plan: "starter", replayed: true });

  const billed = await app.inject({
    method: "GET",
    url: BILLING_PATH,
    headers: { cookie },
  });
  const billedBody = billed.json() as {
    plan: string;
    sourceCap: number;
    stripeCustomerId: string | null;
  };
  assert.equal(billedBody.plan, "starter");
  assert.equal(billedBody.sourceCap, 5);
  assert.ok(billedBody.stripeCustomerId);

  const pro = await app.inject({
    method: "POST",
    url: CHECKOUT_PATH,
    headers: { cookie },
    payload: { plan: "pro" },
  });
  const proBody = pro.json() as { sessionId: string; amountCents: number };
  assert.equal(proBody.amountCents, 1900);
  const proEvent = stripe.completeCheckout(proBody.sessionId);
  assert.ok(proEvent);
  const proHook = await app.inject({
    method: "POST",
    url: WEBHOOK_PATH,
    payload: proEvent,
    headers: { "stripe-signature": FAKE_STRIPE_SIGNATURE },
  });
  assert.equal(proHook.statusCode, 200);
  const afterPro = (
    await app.inject({ method: "GET", url: BILLING_PATH, headers: { cookie } })
  ).json() as { plan: string; sourceCap: number };
  assert.equal(afterPro.plan, "pro");
  assert.equal(afterPro.sourceCap, 25);

  const portal = await app.inject({
    method: "POST",
    url: PORTAL_PATH,
    headers: { cookie },
  });
  assert.equal(portal.statusCode, 200);
  assert.match(
    (portal.json() as { url: string }).url,
    /^https:\/\/billing\.dailybrief\.test\/portal\//,
  );
});

test("subscription deleted returns the user to trial", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  db.prepare("INSERT INTO users (id, email, plan, created_at) VALUES (?, ?, ?, ?)").run(
    "user_a",
    "a@example.com",
    "pro",
    NOW.toISOString(),
  );
  const stripe = createFakeStripe();
  const canceled = stripe.cancelSubscription("user_a");
  const applied = applyStripeEvent(db, canceled);
  assert.deepEqual(applied, {
    ok: true,
    userId: "user_a",
    plan: "trial",
    replayed: false,
  });
  const row = db
    .prepare<[], { plan: string; stripe_subscription_id: string | null }>(
      "SELECT plan, stripe_subscription_id FROM users WHERE id = 'user_a'",
    )
    .get();
  assert.equal(row?.plan, "trial");
  assert.equal(row?.stripe_subscription_id, null);
});

test("checkout without an injected StripePort is 503, not a live call", async () => {
  const email = createFakeEmail();
  const app = await buildApp({
    email,
    authSecret: SECRET,
    now: () => NOW,
    publicBaseUrl: PUBLIC_BASE,
  });
  after(() => app.close());
  const cookie = await signIn(app, email, "ada@example.com");
  const response = await app.inject({
    method: "POST",
    url: CHECKOUT_PATH,
    headers: { cookie },
    payload: { plan: "starter" },
  });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: "billing_unavailable" });
});
