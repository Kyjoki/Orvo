CREATE TABLE IF NOT EXISTS watch_analysis_usage (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period text NOT NULL,
  accepted_count integer NOT NULL DEFAULT 0,
  committed_micro_usd bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, period),
  CONSTRAINT watch_usage_period_format CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT watch_usage_nonnegative CHECK (accepted_count >= 0 AND committed_micro_usd >= 0)
);

-- Contains only opaque event identifiers and accounting, never chat contents.
CREATE TABLE IF NOT EXISTS watch_analysis_events (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  period text NOT NULL,
  reserved_micro_usd bigint NOT NULL,
  actual_micro_usd bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, event_id),
  CONSTRAINT watch_event_id_format CHECK (event_id ~ '^[a-f0-9]{64}$'),
  CONSTRAINT watch_event_cost_nonnegative CHECK (reserved_micro_usd >= 0 AND (actual_micro_usd IS NULL OR actual_micro_usd >= 0))
);
