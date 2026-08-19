export type Plan = "trial" | "starter" | "pro";

export type SourceType =
  | "tiktok_creator"
  | "reddit_sub"
  | "x_account"
  | "ios_reviews";

export const SOURCE_TYPES: readonly SourceType[] = [
  "tiktok_creator",
  "reddit_sub",
  "x_account",
  "ios_reviews",
];

export const PLANS: readonly Plan[] = ["trial", "starter", "pro"];

export const SEND_HOUR = 7 as const;

export type User = {
  id: string;
  email: string;
  timezone: string;
  plan: Plan;
  sendHour: typeof SEND_HOUR;
};

export type Source = {
  id: string;
  userId: string;
  type: SourceType;
  externalId: string;
  label: string;
};

export type Item = {
  id: string;
  type: SourceType;
  externalItemId: string;
  url: string;
  title: string;
  publishedAt: string;
  transcriptOrBody: string | null;
  summary: string | null;
  summaryModel: string | null;
};

export type Delivery = {
  id: string;
  userId: string;
  date: string;
  itemIds: string[];
  sentAt: string | null;
  providerId: string | null;
  partial: boolean;
};
