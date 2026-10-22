-- Owner-approved examples only. Incoming chat messages are never copied here automatically.
CREATE TABLE IF NOT EXISTS watch_feedback (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  label text NOT NULL CHECK (label IN ('important', 'noise')),
  example text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT watch_feedback_example_length CHECK (char_length(example) BETWEEN 12 AND 240)
);

CREATE INDEX IF NOT EXISTS watch_feedback_recent_idx
  ON watch_feedback(workspace_id, created_at DESC);
