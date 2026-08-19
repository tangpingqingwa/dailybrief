import type { SlackPort, SlackPostResult } from "./port.js";

/** Fail-closed adapter. Tests inject `createFakeSlack()`. */
export function createSlackClient(): SlackPort {
  return {
    async post(): Promise<SlackPostResult> {
      return { ok: false, status: 503 };
    },
  };
}
