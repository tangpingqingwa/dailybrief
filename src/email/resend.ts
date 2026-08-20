import {
  EMAIL_TIMEOUT_MS,
  EmailSendError,
  type EmailFetch,
  type EmailMessage,
  type EmailPort,
} from "./port.js";

export const RESEND_API_BASE = "https://api.resend.com";

export type ResendEmailConfig = {
  apiKey: string;
  from: string;
  fetch?: EmailFetch;
  timeoutMs?: number;
};

type ResendPayload = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
};

/** Live Resend EmailPort. Tests inject `fetch`; CI never calls this without a mock. */
export function createResendEmail(config: ResendEmailConfig): EmailPort {
  const baseUrl = RESEND_API_BASE;
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = config.timeoutMs ?? EMAIL_TIMEOUT_MS;

  return {
    async send(message: EmailMessage): Promise<void> {
      const payload: ResendPayload = {
        from: config.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      };
      if (message.html !== undefined) {
        payload.html = message.html;
      }
      if (message.headers !== undefined) {
        payload.headers = { ...message.headers };
      }

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/emails`, {
          method: "POST",
          redirect: "manual",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new EmailSendError(sendFailureMessage(err), 0);
      }

      if (response.status >= 200 && response.status < 300) {
        return;
      }
      throw new EmailSendError(
        `Resend send failed with HTTP ${response.status}`,
        response.status,
      );
    },
  };
}

function sendFailureMessage(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return "Resend send timed out";
  }
  if (err instanceof Error && err.name === "AbortError") {
    return "Resend send timed out";
  }
  return err instanceof Error ? err.message : "Resend send failed";
}
