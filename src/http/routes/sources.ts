import type { FastifyPluginAsync } from "fastify";
import { loadSessionUser, type SessionOptions } from "../../auth/session.js";
import type { ClipClient } from "../../clients/clip.js";
import {
  addTiktokSource,
  deleteSource,
  type AddSourceInput,
} from "../../sources.js";

export const SOURCES_PATH = "/app/sources" as const;
export const SOURCE_DELETE_PATH = "/app/sources/:id/delete" as const;

export type SourcesPluginOptions = SessionOptions & {
  clip: ClipClient;
  freezeNewSources: boolean;
};

type ErrorBody = {
  error: string;
  plan?: string;
  cap?: number;
  count?: number;
};

const ADD_ERROR_STATUS: Record<string, number> = {
  invalid_source: 400,
  unsupported_type: 400,
  frozen_type: 403,
  source_not_found: 400,
  clip_down: 503,
  source_cap: 400,
  source_exists: 409,
};

export const sourcesRoutes: FastifyPluginAsync<SourcesPluginOptions> = async (
  app,
  options,
) => {
  app.post<{ Body: AddSourceInput }>(SOURCES_PATH, async (request, reply) => {
    const user = loadSessionUser(request, app.db, options);
    if (user === null) {
      return reply.code(401).send({ error: "unauthorized" } satisfies ErrorBody);
    }
    const body =
      request.body !== null && typeof request.body === "object"
        ? request.body
        : {};
    const result = await addTiktokSource(app.db, {
      userId: user.id,
      plan: user.plan,
      input: body,
      clip: options.clip,
      now: options.now(),
      freezeNewSources: options.freezeNewSources,
    });
    if (!result.ok) {
      const status = ADD_ERROR_STATUS[result.error] ?? 400;
      return reply.code(status).send({
        error: result.error,
        ...(result.plan !== undefined ? { plan: result.plan } : {}),
        ...(result.cap !== undefined ? { cap: result.cap } : {}),
        ...(result.count !== undefined ? { count: result.count } : {}),
      } satisfies ErrorBody);
    }
    return reply.code(201).send({ source: result.source });
  });

  app.post<{ Params: { id?: string } }>(
    SOURCE_DELETE_PATH,
    async (request, reply) => {
      const user = loadSessionUser(request, app.db, options);
      if (user === null) {
        return reply.code(401).send({ error: "unauthorized" } satisfies ErrorBody);
      }
      const id = request.params.id;
      if (id === undefined || id === "") {
        return reply.code(404).send({ error: "not_found" } satisfies ErrorBody);
      }
      const result = deleteSource(app.db, user.id, id);
      if (result === "not_found") {
        return reply.code(404).send({ error: "not_found" } satisfies ErrorBody);
      }
      return reply.code(200).send({ ok: true });
    },
  );
};
