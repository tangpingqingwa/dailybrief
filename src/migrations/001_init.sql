-- v1 sources are per-user (SPEC §5). Items stay global so two users
-- following the same video share one summary row.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  plan TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'starter', 'pro')),
  send_hour INTEGER NOT NULL DEFAULT 7 CHECK (send_hour = 7),
  created_at TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'tiktok_creator',
    'reddit_sub',
    'x_account',
    'ios_reviews'
  )),
  external_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, type, external_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (
    'tiktok_creator',
    'reddit_sub',
    'x_account',
    'ios_reviews'
  )),
  external_item_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  transcript_or_body TEXT,
  summary TEXT,
  summary_model TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (type, external_item_id)
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  item_ids TEXT NOT NULL DEFAULT '[]',
  sent_at TEXT,
  provider_id TEXT,
  partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, local_date),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
