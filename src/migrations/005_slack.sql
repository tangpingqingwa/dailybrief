-- Pro incoming Slack webhook (SPEC §4, §8). NULL means email only.
ALTER TABLE users ADD COLUMN slack_webhook_url TEXT;
