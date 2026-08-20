import type { DailyBriefDb } from "../db.js";
import type { SlackPort } from "../slack/port.js";

declare module "fastify" {
  interface FastifyInstance {
    db: DailyBriefDb;
    slack: SlackPort;
  }
}

export {};
