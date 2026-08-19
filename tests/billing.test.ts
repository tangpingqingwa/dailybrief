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
import { createStripeClient } from "../src/billing/stripe.js";
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
  const stripe = createStripeClient({ secretKey: "sk_test_should_not_matter" });
  await assert.rejects(stripe.createCheckoutSession({
    userId: "usr_1",
    email: "a@example.com",
    plan: "starter",
    successUrl: "http://x/ok",
    cancelUrl: "http://x/no",
  }), /live Stripe is not enabled/);
  assert.equal(stripe.constructEvent({ type: "checkout.session.completed" }, "sig"), null);
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
