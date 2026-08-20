import { liveSlackEnabled } from "../config.js";
import type { SlackMessage, SlackPort, SlackPostResult } from "./port.js";
import { parseSlackWebhookUrl } from "./webhook.js";

export const SLACK_TIMEOUT_MS = 8_000;

export type SlackFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type CreateSlackOptions = {
  env?: NodeJS.ProcessEnv;
  fetch?: SlackFetch;
  timeoutMs?: number;
};

/** Fail-closed unless SLACK_LIVE=1. Tests inject `createFakeSlack()`. */
export function createSlackClient(options: CreateSlackOptions = {}): SlackPort {
  const env = options.env ?? process.env;
  if (!liveSlackEnabled(env)) {
    return createUnavailableSlack();
  }
  return createLiveSlack({
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

export function createUnavailableSlack(): SlackPort {
  return {
    async post(): Promise<SlackPostResult> {
      return { ok: false, status: 503 };
    },
  };
}

export function createLiveSlack(options: {
  fetch?: SlackFetch;
  timeoutMs?: number;
} = {}): SlackPort {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? SLACK_TIMEOUT_MS;
  return {
    async post(
      webhookUrl: string,
      message: SlackMessage,
    ): Promise<SlackPostResult> {
      const url = parseSlackWebhookUrl(webhookUrl);
      if (url === null) {
        return { ok: false, status: 400 };
      }
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          redirect: "manual",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: message.text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
        };
      } catch {
        return { ok: false, status: 0 };
      }
    },
  };
}
