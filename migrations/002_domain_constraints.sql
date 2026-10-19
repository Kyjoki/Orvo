ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tasks ADD CONSTRAINT tasks_status_valid CHECK (status IN ('draft','scheduled','queued','running','waiting_for_input','waiting_for_approval','pause_requested','paused','retry_scheduled','ready_for_review','completed','failed','cancel_requested','cancelled'));
ALTER TABLE approvals ADD CONSTRAINT approvals_state_valid CHECK (state IN ('pending','approved','rejected','revoked','expired'));
ALTER TABLE memories ADD CONSTRAINT memory_scope_owner_valid CHECK ((scope='workspace' AND agent_id IS NULL AND project_id IS NULL) OR (scope='agent' AND agent_id IS NOT NULL) OR (scope='project' AND project_id IS NOT NULL AND agent_id IS NULL));
