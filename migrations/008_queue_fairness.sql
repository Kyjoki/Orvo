ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dispatch_attempted_at timestamptz;
ALTER TABLE runtime_controls ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
