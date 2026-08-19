import type { FastifyRequest } from "fastify";
import type { DailyBriefDb } from "../db.js";
import type { User } from "../types.js";
import { readCookie, SESSION_COOKIE } from "./cookie.js";
import { verifySession } from "./token.js";
import { findUserById } from "./users.js";

export type SessionOptions = {
  authSecret: string;
  now: () => Date;
};

export function loadSessionUser(
  request: FastifyRequest,
  db: DailyBriefDb,
  options: SessionOptions,
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

export function headerString(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value.join("; ");
  }
  return value;
}
