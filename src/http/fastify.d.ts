import type { DailyBriefDb } from "../db.js";

declare module "fastify" {
  interface FastifyInstance {
    db: DailyBriefDb;
  }
}

export {};
