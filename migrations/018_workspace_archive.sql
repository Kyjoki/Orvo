ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS workspaces_owner_archive ON workspace_owners(owner_id, workspace_id);
