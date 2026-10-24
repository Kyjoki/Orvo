CREATE TABLE IF NOT EXISTS workspace_owners (
  owner_id text NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, workspace_id)
);

INSERT INTO workspace_owners(owner_id, workspace_id)
SELECT id, workspace_id FROM owners
ON CONFLICT DO NOTHING;
