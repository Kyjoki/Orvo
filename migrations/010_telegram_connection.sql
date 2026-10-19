CREATE TABLE IF NOT EXISTS telegram_connections (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  bot_username text NOT NULL,
  token_hash text NOT NULL,
  paired_at timestamptz NOT NULL DEFAULT now(),
  last_test_at timestamptz
);
