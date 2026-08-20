import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EmailMessage, EmailPort } from "./port.js";

export type FileEmail = EmailPort & {
  path: string;
  sent: EmailMessage[];
};

function copyMessage(message: EmailMessage): EmailMessage {
  return {
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html !== undefined ? { html: message.html } : {}),
    ...(message.headers !== undefined ? { headers: { ...message.headers } } : {}),
  };
}

export function readEmailSink(path: string): EmailMessage[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  if (raw.trim() === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as EmailMessage[]) : [];
  } catch {
    return [];
  }
}

/** Operator sink: append each send as JSON so live-smoke can assert unsub. */
export function createFileEmail(path: string): FileEmail {
  const sent: EmailMessage[] = readEmailSink(path);
  return {
    path,
    sent,
    async send(message: EmailMessage): Promise<void> {
      const existing = readEmailSink(path);
      const copy = copyMessage(message);
      existing.push(copy);
      sent.push(copy);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
    },
  };
}
