import Fastify, { type FastifyInstance } from "fastify";
import { authRoutes } from "./auth/routes.js";
import { loadAuthSecret, parsePublicBaseUrl } from "./config.js";
import { openDatabase, type DailyBriefDb } from "./db.js";
import { createConsoleEmail } from "./email/console.js";
import type { EmailPort } from "./email/port.js";
import { healthRoutes } from "./http/routes/health.js";

export type BuildAppOptions = {
  logger?: boolean;
  db?: DailyBriefDb;
  databasePath?: string;
  email?: EmailPort;
  authSecret?: string;
  publicBaseUrl?: string;
  now?: () => Date;
  secureCookies?: boolean;
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
  await app.register(authRoutes, {
    email: options.email ?? createConsoleEmail(),
    authSecret: options.authSecret ?? loadAuthSecret(),
    publicBaseUrl: options.publicBaseUrl ?? parsePublicBaseUrl(),
    now: options.now ?? (() => new Date()),
    secureCookies: options.secureCookies ?? process.env.NODE_ENV === "production",
  });
  return app;
}
