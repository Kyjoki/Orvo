CREATE TABLE IF NOT EXISTS mfa_session_grants (
  session_id text PRIMARY KEY,
  user_id text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_session_grants_user ON mfa_session_grants(user_id);

CREATE TABLE IF NOT EXISTS mfa_totp_replay (
  key text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS mfa_totp_replay_expiry ON mfa_totp_replay(expires_at);
