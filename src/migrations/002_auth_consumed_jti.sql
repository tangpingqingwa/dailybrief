-- Magic-link tokens are HMAC-signed and carry a jti. Insert-on-consume
-- makes each token single-use across process restarts.
CREATE TABLE auth_consumed_jti (
  jti TEXT PRIMARY KEY,
  consumed_at TEXT NOT NULL
);
