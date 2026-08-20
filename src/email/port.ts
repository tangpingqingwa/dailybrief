export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
};

export type EmailPort = {
  send(message: EmailMessage): Promise<void>;
};

export type EmailFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class EmailUnavailableError extends Error {
  readonly code = "email_unavailable" as const;

  constructor(message = "live email is not enabled; inject EmailPort") {
    super(message);
    this.name = "EmailUnavailableError";
  }
}

export class EmailSendError extends Error {
  readonly code = "email_send_failed" as const;
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "EmailSendError";
    this.status = status;
  }
}

export const EMAIL_TIMEOUT_MS = 8_000;
