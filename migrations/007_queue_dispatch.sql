ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dispatch_lease_token text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dispatch_lease_until timestamptz;
CREATE INDEX IF NOT EXISTS tasks_dispatch_lease ON tasks(workspace_id,status,dispatch_lease_until)
  WHERE status IN ('queued','scheduled');
