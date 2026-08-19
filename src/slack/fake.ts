import type { SlackMessage, SlackPort, SlackPostResult } from "./port.js";

export type FakeSlackPost = {
  webhookUrl: string;
  text: string;
  status: number;
};

export type FakeSlack = SlackPort & {
  posted: FakeSlackPost[];
  setStatus(webhookUrl: string, status: number): void;
  throwOnPost(error?: Error): void;
};

export function createFakeSlack(): FakeSlack {
  const posted: FakeSlackPost[] = [];
  const statuses = new Map<string, number>();
  let throwError: Error | null = null;
  return {
    posted,
    setStatus(webhookUrl: string, status: number): void {
      statuses.set(webhookUrl, status);
    },
    throwOnPost(error = new Error("slack_unavailable")): void {
      throwError = error;
    },
    async post(
      webhookUrl: string,
      message: SlackMessage,
    ): Promise<SlackPostResult> {
      if (throwError !== null) {
        throw throwError;
      }
      const status = statuses.get(webhookUrl) ?? 200;
      posted.push({ webhookUrl, text: message.text, status });
      return { ok: status >= 200 && status < 300, status };
    },
  };
}
