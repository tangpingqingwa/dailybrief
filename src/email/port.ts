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
