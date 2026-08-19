import type { EmailMessage, EmailPort } from "./port.js";

export type SentEmail = EmailMessage;

export type FakeEmail = EmailPort & {
  sent: SentEmail[];
};

export function createFakeEmail(): FakeEmail {
  const sent: SentEmail[] = [];
  return {
    sent,
    async send(message: EmailMessage): Promise<void> {
      sent.push({
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html !== undefined ? { html: message.html } : {}),
        ...(message.headers !== undefined ? { headers: { ...message.headers } } : {}),
      });
    },
  };
}

export function extractMagicLinkToken(text: string): string {
  const match = text.match(/[?&]token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  if (match === null) {
    throw new Error("email text does not contain a magic-link token");
  }
  return match[1];
}

export function extractUnsubToken(text: string): string {
  const match = text.match(/\/unsub\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  if (match === null) {
    throw new Error("email text does not contain an unsubscribe token");
  }
  return match[1];
}
