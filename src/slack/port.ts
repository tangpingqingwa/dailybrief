export type SlackMessage = {
  text: string;
};

export type SlackPostResult = {
  ok: boolean;
  status: number;
};

export type SlackPort = {
  post(webhookUrl: string, message: SlackMessage): Promise<SlackPostResult>;
};
