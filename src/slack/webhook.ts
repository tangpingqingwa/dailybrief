import type { Plan } from "../types.js";

const MIN_WEBHOOK_LEN = 16;
const MAX_WEBHOOK_LEN = 512;

export function slackEnabledForPlan(plan: Plan): boolean {
  return plan === "pro";
}

export function parseSlackWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < MIN_WEBHOOK_LEN || trimmed.length > MAX_WEBHOOK_LEN) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  if (url.username !== "" || url.password !== "") {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "hooks.slack.com" && host !== "hooks.slack.test") {
    return null;
  }
  if (url.pathname === "/" || url.pathname === "") {
    return null;
  }
  return trimmed;
}
