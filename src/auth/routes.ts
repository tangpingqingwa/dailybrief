import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { EmailPort } from "../email/port.js";
import type { User } from "../types.js";
import {
  clearSessionCookie,
  readCookie,
  serializeSessionCookie,
  SESSION_COOKIE,
} from "./cookie.js";
import { normalizeEmail } from "./email.js";
import {
  SESSION_TTL_MS,
  signMagicLink,
  signSession,
  verifyMagicLink,
  verifySession,
} from "./token.js";
import { consumeMagicLinkJti, findOrCreateUser, findUserById } from "./users.js";

export const MAGIC_LINK_PATH = "/auth/magic-link" as const;
export const VERIFY_PATH = "/auth/verify" as const;
export const LOGOUT_PATH = "/auth/logout" as const;
export const APP_PATH = "/app" as const;

export type AuthPluginOptions = {
  email: EmailPort;
  authSecret: string;
  publicBaseUrl: string;
  now: () => Date;
  secureCookies: boolean;
};

type ErrorBody = { error: string };

export const authRoutes: FastifyPluginAsync<AuthPluginOptions> = async (
  app,
  options,
) => {
  app.post<{ Body: { email?: unknown } }>(MAGIC_LINK_PATH, async (request, reply) => {
    if (request.body === null || typeof request.body !== "object") {
      return reply.code(400).send({ error: "invalid_email" } satisfies ErrorBody);
    }
    const email = normalizeEmail(request.body.email);
    if (email === null) {
      return reply.code(400).send({ error: "invalid_email" } satisfies ErrorBody);
    }
    const { token } = signMagicLink(email, options.now(), options.authSecret);
    const url = `${options.publicBaseUrl}${VERIFY_PATH}?token=${token}`;
    await options.email.send({
      to: email,
      subject: "Your DailyBrief sign-in link",
      text: [
        "Sign in to DailyBrief:",
        "",
        url,
        "",
        "This link expires in 20 minutes and can be used once.",
      ].join("\n"),
    });
    return reply.code(202).send({ ok: true });
  });

  app.get<{ Querystring: { token?: string } }>(VERIFY_PATH, async (request, reply) => {
    const token = request.query.token;
    if (token === undefined || token === "") {
      return reply.code(401).send({ error: "invalid_token" } satisfies ErrorBody);
    }
    const now = options.now();
    const claims = verifyMagicLink(token, now, options.authSecret);
    if (claims === null) {
      return reply.code(401).send({ error: "invalid_token" } satisfies ErrorBody);
    }
    if (!consumeMagicLinkJti(app.db, claims.jti, now)) {
      return reply.code(401).send({ error: "invalid_token" } satisfies ErrorBody);
    }
    const user = findOrCreateUser(app.db, claims.email, now);
    const session = signSession(user.id, now, options.authSecret);
    reply.header(
      "Set-Cookie",
      serializeSessionCookie(session, {
        maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),
        secure: options.secureCookies,
      }),
    );
    return reply.redirect(APP_PATH, 302);
  });

  app.post(LOGOUT_PATH, async (_request, reply) => {
    reply.header(
      "Set-Cookie",
      clearSessionCookie({ secure: options.secureCookies }),
    );
    return reply.code(204).send();
  });

  app.get(APP_PATH, async (request, reply) => {
    const user = loadSessionUser(request, app.db, options);
    if (user === null) {
      return reply.code(401).send({ error: "unauthorized" } satisfies ErrorBody);
    }
    return { user, sources: [] };
  });
};

function loadSessionUser(
  request: FastifyRequest,
  db: FastifyRequest["server"]["db"],
  options: AuthPluginOptions,
): User | null {
  const token = readCookie(headerString(request.headers.cookie), SESSION_COOKIE);
  if (token === null) {
    return null;
  }
  const claims = verifySession(token, options.now(), options.authSecret);
  if (claims === null) {
    return null;
  }
  return findUserById(db, claims.sub);
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.join("; ");
  }
  return value;
}
