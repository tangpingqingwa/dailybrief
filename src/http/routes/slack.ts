import type { FastifyPluginAsync } from "fastify";
import { loadSessionUser, type SessionOptions } from "../../auth/session.js";
import {
  findUserSlackWebhook,
  setUserSlackWebhook,
} from "../../auth/users.js";
import {
  parseSlackWebhookUrl,
  slackEnabledForPlan,
} from "../../slack/webhook.js";

export const SLACK_PATH = "/app/slack" as const;
export const SLACK_DELETE_PATH = "/app/slack/delete" as const;

export type SlackPluginOptions = SessionOptions;

type ErrorBody = { error: string };

export const slackRoutes: FastifyPluginAsync<SlackPluginOptions> = async (
  app,
  options,
) => {
  app.get(SLACK_PATH, async (request, reply) => {
    const user = loadSessionUser(request, app.db, options);
    if (user === null) {
      return reply.code(401).send({ error: "unauthorized" } satisfies ErrorBody);
    }
    const webhookUrl = findUserSlackWebhook(app.db, user.id);
    return {
      plan: user.plan,
      slackEnabled: slackEnabledForPlan(user.plan),
      configured: webhookUrl !== null,
    };
  });

  app.post<{ Body: { webhookUrl?: unknown } }>(
    SLACK_PATH,
    async (request, reply) => {
      const user = loadSessionUser(request, app.db, options);
      if (user === null) {
        return reply.code(401).send({ error: "unauthorized" } satisfies ErrorBody);
      }
      if (!slackEnabledForPlan(user.plan)) {
        return reply
          .code(403)
          .send({ error: "slack_not_allowed" } satisfies ErrorBody);
      }
      const raw =
        request.body !== null && typeof request.body === "object"
          ? request.body.webhookUrl
          : undefined;
      const webhookUrl = parseSlackWebhookUrl(raw);
      if (webhookUrl === null) {
        return reply
          .code(400)
          .send({ error: "invalid_webhook" } satisfies ErrorBody);
      }
      setUserSlackWebhook(app.db, user.id, webhookUrl);
      return { ok: true, configured: true };
    },
  );

  app.post(SLACK_DELETE_PATH, async (request, reply) => {
    const user = loadSessionUser(request, app.db, options);
    if (user === null) {
      return reply.code(401).send({ error: "unauthorized" } satisfies ErrorBody);
    }
    setUserSlackWebhook(app.db, user.id, null);
    return { ok: true, configured: false };
  });
};
