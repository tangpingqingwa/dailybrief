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
import { createConsoleEmail } from "./email/console.js";
import type { EmailPort } from "./email/port.js";
import { billingRoutes } from "./http/routes/billing.js";
import { healthRoutes } from "./http/routes/health.js";
import { slackRoutes } from "./http/routes/slack.js";
import { sourcesRoutes } from "./http/routes/sources.js";
import { unsubRoutes } from "./http/routes/unsub.js";

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
  clip?: ClipClient;
  freezeNewSources?: boolean;
};

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
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
    email: options.email ?? createConsoleEmail(),
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
  await app.register(billingRoutes, {
    ...session,
    stripe: options.stripe ?? createStripeClient(),
    publicBaseUrl,
  });
  await app.register(slackRoutes, session);
  return app;
}
