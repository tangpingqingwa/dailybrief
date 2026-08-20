import Fastify, { type FastifyInstance } from "fastify";
import { authRoutes } from "./auth/routes.js";
import type { StripePort } from "./billing/port.js";
import { createStripeClient } from "./billing/stripe.js";
import { createClipClient, type ClipClient } from "./clients/clip.js";
import {
  loadAuthSecret,
  parseFreezeNewSources,
  parsePublicBaseUrl,
} from "./config.js";
import { openDatabase, type DailyBriefDb } from "./db.js";
import { createEmail } from "./email/create.js";
import type { EmailPort } from "./email/port.js";
import { billingRoutes } from "./http/routes/billing.js";
import { healthRoutes } from "./http/routes/health.js";
import { slackRoutes } from "./http/routes/slack.js";
import { sourcesRoutes } from "./http/routes/sources.js";
import { unsubRoutes } from "./http/routes/unsub.js";
import { runDailySend, type SendRunResult } from "./send.js";
import { createSlackClient } from "./slack/http.js";
import type { SlackPort } from "./slack/port.js";

export type BuildAppOptions = {
  logger?: boolean;
  db?: DailyBriefDb;
  databasePath?: string;
  email?: EmailPort;
  authSecret?: string;
  publicBaseUrl?: string;
  now?: () => Date;
  secureCookies?: boolean;
  stripe?: StripePort;
  slack?: SlackPort;
  clip?: ClipClient;
  freezeNewSources?: boolean;
};

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // HMAC unsub tokens are base64url JSON + sig; default 100 is too short.
    routerOptions: { maxParamLength: 2048 },
  });
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const text = raw.toString("utf8");
      if (request.url.split("?")[0] === "/billing/webhook") {
        done(null, text);
        return;
      }
      if (raw.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text) as unknown);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
  const ownsDb = options.db === undefined;
  const db = options.db ?? openDatabase(options.databasePath ?? ":memory:");
  app.decorate("db", db);
  if (ownsDb) {
    app.addHook("onClose", async (instance) => {
      instance.db.close();
    });
  }
  await app.register(healthRoutes);
  const authSecret = options.authSecret ?? loadAuthSecret();
  const now = options.now ?? (() => new Date());
  const publicBaseUrl = options.publicBaseUrl ?? parsePublicBaseUrl();
  const session = { authSecret, now };
  await app.register(authRoutes, {
    email: options.email ?? createEmail(),
    authSecret,
    publicBaseUrl,
    now,
    secureCookies: options.secureCookies ?? process.env.NODE_ENV === "production",
  });
  await app.register(unsubRoutes, session);
  await app.register(sourcesRoutes, {
    ...session,
    clip: options.clip ?? createClipClient(),
    freezeNewSources: options.freezeNewSources ?? parseFreezeNewSources(),
  });
  const stripe = options.stripe ?? createStripeClient();
  const slack = options.slack ?? createSlackClient();
  app.decorate("slack", slack);
  await app.register(billingRoutes, {
    ...session,
    stripe,
    publicBaseUrl,
  });
  await app.register(slackRoutes, session);
  return app;
}

/** Daily send uses the same EmailPort / SlackPort wired into `buildApp`. */
export async function sendDailyFromApp(
  app: FastifyInstance,
  args: {
    email: EmailPort;
    authSecret: string;
    publicBaseUrl: string;
    now?: Date;
    delayedHandles?: readonly string[];
    slack?: SlackPort;
  },
): Promise<SendRunResult> {
  return runDailySend({
    db: app.db,
    email: args.email,
    slack: args.slack ?? app.slack,
    authSecret: args.authSecret,
    publicBaseUrl: args.publicBaseUrl,
    ...(args.now !== undefined ? { now: args.now } : {}),
    ...(args.delayedHandles !== undefined
      ? { delayedHandles: args.delayedHandles }
      : {}),
  });
}
