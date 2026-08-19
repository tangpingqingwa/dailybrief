export type SummaryPort = {
  summarize(text: string): Promise<string>;
};
