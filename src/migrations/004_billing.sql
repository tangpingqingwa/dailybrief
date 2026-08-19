-- Stripe customer / subscription ids for $9 starter and $19 pro (SPEC §4).
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
