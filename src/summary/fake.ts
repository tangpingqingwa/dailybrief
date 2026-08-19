import type { SummaryPort } from "./port.js";

export const MAX_SUMMARY_WORDS = 80;
export const FAKE_SUMMARY_MODEL = "fake";

export function firstWords(text: string, max = MAX_SUMMARY_WORDS): string {
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length <= max) {
    return words.join(" ");
  }
  return words.slice(0, max).join(" ");
}

export function createFakeSummary(): SummaryPort {
  return {
    async summarize(text: string): Promise<string> {
      return firstWords(text);
    },
  };
}
