import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { unsubscribeUser } from "../../auth/users.js";
import { verifyUnsub } from "../../auth/token.js";

export const UNSUB_PATH = "/unsub/:token" as const;

export type UnsubPluginOptions = {
  authSecret: string;
  now: () => Date;
};

type ErrorBody = { error: string };

export const unsubRoutes: FastifyPluginAsync<UnsubPluginOptions> = async (
  app,
  options,
) => {
  const handle = async (
    request: FastifyRequest<{ Params: { token?: string } }>,
    reply: FastifyReply,
  ) => {
    const token = request.params.token;
    if (token === undefined || token === "") {
      return reply.code(401).send({ error: "invalid_token" } satisfies ErrorBody);
    }
    const claims = verifyUnsub(token, options.authSecret);
    if (claims === null) {
      return reply.code(401).send({ error: "invalid_token" } satisfies ErrorBody);
    }
    const result = unsubscribeUser(app.db, claims.sub, options.now());
    if (result === "missing") {
      return reply.code(401).send({ error: "invalid_token" } satisfies ErrorBody);
    }
    const text =
      result === "already"
        ? "You are already unsubscribed from DailyBrief."
        : "You are unsubscribed from DailyBrief. No further emails will be sent.";
    return reply.code(200).type("text/plain; charset=utf-8").send(text);
  };

  app.get(UNSUB_PATH, handle);
  app.post(UNSUB_PATH, handle);
};
