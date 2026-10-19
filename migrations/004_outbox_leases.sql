ALTER TABLE runtime_controls ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE runtime_controls ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE runtime_controls ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS runtime_controls_claim_idx ON runtime_controls(workspace_id,state,lease_until,created_at);
