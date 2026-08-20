import { createFileEmail } from "./file.js";
import type { EmailMessage, EmailPort } from "./port.js";

export type ConsoleEmailOptions = {
  /** When set, also persist JSON so an operator script can read the send. */
  path?: string;
};

export function createConsoleEmail(options: ConsoleEmailOptions = {}): EmailPort {
  const file = options.path !== undefined ? createFileEmail(options.path) : null;
  return {
    async send(message: EmailMessage): Promise<void> {
      console.log(
        `[email] to=${message.to} subject=${message.subject}\n${message.text}`,
      );
      if (file !== null) {
        await file.send(message);
      }
    },
  };
}
