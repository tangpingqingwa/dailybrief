import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MAGIC_LINK_TTL_MS = 20 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_MAX_LENGTH = 4096;

export type MagicLinkClaims = {
  v: 1;
  email: string;
  exp: number;
  jti: string;
};

export type SessionClaims = {
  v: 1;
  sub: string;
  exp: number;
};

export function newJti(): string {
  return randomBytes(16).toString("hex");
}

export function signMagicLink(
  email: string,
  now: Date,
  secret: string,
  ttlMs = MAGIC_LINK_TTL_MS,
): { token: string; claims: MagicLinkClaims } {
  const claims: MagicLinkClaims = {
    v: 1,
    email,
    exp: now.getTime() + ttlMs,
    jti: newJti(),
  };
  return { token: signPayload(claims, secret), claims };
}

export function verifyMagicLink(
  token: string,
  now: Date,
  secret: string,
): MagicLinkClaims | null {
  const payload = verifyPayload(token, secret);
  if (!isMagicLinkClaims(payload)) {
    return null;
  }
  if (payload.exp <= now.getTime()) {
    return null;
  }
  return payload;
}

export function signSession(
  userId: string,
  now: Date,
  secret: string,
  ttlMs = SESSION_TTL_MS,
): string {
  const claims: SessionClaims = {
    v: 1,
    sub: userId,
    exp: now.getTime() + ttlMs,
  };
  return signPayload(claims, secret);
}

export function verifySession(
  token: string,
  now: Date,
  secret: string,
): SessionClaims | null {
  const payload = verifyPayload(token, secret);
  if (!isSessionClaims(payload)) {
    return null;
  }
  if (payload.exp <= now.getTime()) {
    return null;
  }
  return payload;
}

function signPayload(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyPayload(token: string, secret: string): unknown | null {
  if (token.length === 0 || token.length > TOKEN_MAX_LENGTH) {
    return null;
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || token.indexOf(".", dot + 1) !== -1) {
    return null;
  }
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(body).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function isMagicLinkClaims(value: unknown): value is MagicLinkClaims {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    rec.v === 1 &&
    typeof rec.email === "string" &&
    rec.email.length > 0 &&
    typeof rec.exp === "number" &&
    Number.isFinite(rec.exp) &&
    typeof rec.jti === "string" &&
    rec.jti.length >= 16
  );
}

function isSessionClaims(value: unknown): value is SessionClaims {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    rec.v === 1 &&
    typeof rec.sub === "string" &&
    rec.sub.length > 0 &&
    typeof rec.exp === "number" &&
    Number.isFinite(rec.exp)
  );
}
