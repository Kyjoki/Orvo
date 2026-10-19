CREATE TABLE IF NOT EXISTS rate_buckets (
  key text PRIMARY KEY,
  count integer NOT NULL CHECK (count >= 0),
  reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_buckets_reset_at ON rate_buckets(reset_at);
