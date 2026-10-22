-- A one-day, owner-only review journal. Payloads are encrypted by the application.
CREATE TABLE IF NOT EXISTS watch_candidate_reviews (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  capture_day text NOT NULL,
  observed_at timestamptz NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  auth_tag text NOT NULL,
  label text CHECK (label IN ('important', 'noise')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, event_id)
);

CREATE INDEX IF NOT EXISTS watch_candidate_reviews_day_idx
  ON watch_candidate_reviews(workspace_id, capture_day, observed_at DESC, event_id DESC);
