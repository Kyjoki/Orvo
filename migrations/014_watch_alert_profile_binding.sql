-- Existing alerts have no profile attribution and must never be sent under a new policy.
ALTER TABLE watch_alert_outbox ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE watch_alert_outbox ADD COLUMN IF NOT EXISTS agent_version integer;
ALTER TABLE watch_alert_outbox ADD COLUMN IF NOT EXISTS connection_generation text;

UPDATE watch_alert_outbox
SET state='expired',ciphertext=NULL,nonce=NULL,auth_tag=NULL,lease_token=NULL,lease_until=NULL,
    agent_id=NULL,agent_version=NULL,connection_generation=NULL
WHERE state IN ('pending','leased');

UPDATE watch_alert_outbox SET agent_id=NULL,agent_version=NULL,connection_generation=NULL
WHERE state IN ('delivered','expired','dead') AND
  (agent_id IS NULL OR agent_version IS NULL OR connection_generation IS NULL);

ALTER TABLE watch_alert_outbox
  ADD CONSTRAINT watch_alert_agent_fk FOREIGN KEY (workspace_id,agent_id) REFERENCES agents(workspace_id,id),
  ADD CONSTRAINT watch_alert_agent_binding CHECK (
    (agent_id IS NULL AND agent_version IS NULL AND connection_generation IS NULL AND state IN ('delivered','expired','dead'))
    OR (agent_id IS NOT NULL AND agent_version > 0 AND connection_generation ~ '^[a-f0-9]{64}$')
  );
