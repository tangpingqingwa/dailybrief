import { liveEmailEnabled } from "../config.js";
import { createConsoleEmail } from "./console.js";
import {
  EmailUnavailableError,
  type EmailFetch,
  type EmailPort,
} from "./port.js";
import { createResendEmail, type ResendEmailConfig } from "./resend.js";
import { createSesEmail, parseAwsRegion, type SesEmailConfig } from "./ses.js";

export { parseAwsRegion } from "./ses.js";

export type { EmailFetch } from "./port.js";
export { EmailSendError, EmailUnavailableError } from "./port.js";

export type EmailProvider = "resend" | "ses";

export type CreateEmailOptions = {
  env?: NodeJS.ProcessEnv;
  fetch?: EmailFetch;
  now?: () => Date;
};

export type ResolvedEmailAdapter =
  | { kind: "console" }
  | { kind: "unavailable"; reason: string }
  | { kind: "resend"; config: ResendEmailConfig }
  | { kind: "ses"; config: SesEmailConfig };

/**
 * Default is console (dev) / fail-closed (production). Live Resend or SES
 * requires EMAIL_LIVE=1, EMAIL_PROVIDER, EMAIL_FROM, and provider secrets.
 */
export function createEmail(options: CreateEmailOptions = {}): EmailPort {
  const env = options.env ?? process.env;
  const resolved = resolveEmailAdapter(env);
  switch (resolved.kind) {
    case "console":
      return createConsoleEmail();
    case "unavailable":
      return createUnavailableEmail(resolved.reason);
    case "resend":
      return createResendEmail({
        ...resolved.config,
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      });
    case "ses":
      return createSesEmail({
        ...resolved.config,
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
  }
}

export function resolveEmailAdapter(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEmailAdapter {
  if (!liveEmailEnabled(env)) {
    if ((env.NODE_ENV ?? "development") === "production") {
      return {
        kind: "unavailable",
        reason: "EMAIL_LIVE is not enabled",
      };
    }
    return { kind: "console" };
  }

  const provider = parseEmailProvider(env.EMAIL_PROVIDER);
  if (provider === null) {
    return {
      kind: "unavailable",
      reason: "EMAIL_PROVIDER must be resend or ses",
    };
  }
  const from = parseEmailFrom(env.EMAIL_FROM);
  if (from === null) {
    return { kind: "unavailable", reason: "EMAIL_FROM is required" };
  }

  if (provider === "resend") {
    const apiKey = nonEmpty(env.RESEND_API_KEY);
    if (apiKey === null) {
      return { kind: "unavailable", reason: "RESEND_API_KEY is required" };
    }
    return { kind: "resend", config: { apiKey, from } };
  }

  const accessKeyId = nonEmpty(env.AWS_ACCESS_KEY_ID);
  const secretAccessKey = nonEmpty(env.AWS_SECRET_ACCESS_KEY);
  if (accessKeyId === null || secretAccessKey === null) {
    return {
      kind: "unavailable",
      reason: "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required",
    };
  }
  const region = parseAwsRegion(
    env.SES_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
  );
  if (region === null) {
    return { kind: "unavailable", reason: "AWS_REGION is invalid" };
  }
  const sessionToken = nonEmpty(env.AWS_SESSION_TOKEN);
  return {
    kind: "ses",
    config: {
      from,
      region,
      accessKeyId,
      secretAccessKey,
      ...(sessionToken !== null ? { sessionToken } : {}),
    },
  };
}

export function parseEmailProvider(value: string | undefined): EmailProvider | null {
  if (value === "resend" || value === "ses") {
    return value;
  }
  return null;
}

export function parseEmailFrom(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 320) {
    return null;
  }
  const angle = trimmed.match(/^(.+?)\s*<([^<>]+)>$/);
  const addr = (angle !== null ? angle[2] : trimmed).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
    return null;
  }
  return trimmed;
}

export function createUnavailableEmail(reason?: string): EmailPort {
  return {
    async send(): Promise<void> {
      throw new EmailUnavailableError(
        reason === undefined
          ? "live email is not enabled; inject EmailPort"
          : `live email is not enabled: ${reason}`,
      );
    },
  };
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
