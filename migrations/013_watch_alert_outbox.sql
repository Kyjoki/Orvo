-- Only encrypted, short-lived Telegram alert text is stored. No chat excerpts.
CREATE TABLE IF NOT EXISTS watch_alert_outbox (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  ciphertext text,
  nonce text,
  auth_tag text,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  expires_at timestamptz NOT NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,event_id),
  FOREIGN KEY (workspace_id,event_id) REFERENCES watch_analysis_events(workspace_id,event_id) ON DELETE CASCADE,
  CONSTRAINT watch_alert_state CHECK (state IN ('pending','leased','delivered','expired','dead')),
  CONSTRAINT watch_alert_attempts CHECK (attempts BETWEEN 0 AND 3),
  CONSTRAINT watch_alert_encrypted CHECK ((state IN ('pending','leased') AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL)
    OR (state IN ('delivered','expired','dead') AND ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL))
);
CREATE INDEX IF NOT EXISTS watch_alert_due_idx ON watch_alert_outbox(state,next_attempt_at,lease_until,expires_at)
  WHERE state IN ('pending','leased');
