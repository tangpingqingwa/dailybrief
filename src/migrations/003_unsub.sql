-- One-click unsubscribe (SPEC §4, §9). NULL means still subscribed.
ALTER TABLE users ADD COLUMN unsubscribed_at TEXT;
