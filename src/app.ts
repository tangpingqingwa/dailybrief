import Fastify, { type FastifyInstance } from "fastify";
import { openDatabase, type DailyBriefDb } from "./db.js";
import { healthRoutes } from "./http/routes/health.js";

export type BuildAppOptions = {
  logger?: boolean;
  db?: DailyBriefDb;
  databasePath?: string;
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
  return app;
}
