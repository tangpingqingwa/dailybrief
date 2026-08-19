import type { EmailMessage, EmailPort } from "./port.js";

export function createConsoleEmail(): EmailPort {
  return {
    async send(message: EmailMessage): Promise<void> {
      console.log(
        `[email] to=${message.to} subject=${message.subject}\n${message.text}`,
      );
    },
  };
}
