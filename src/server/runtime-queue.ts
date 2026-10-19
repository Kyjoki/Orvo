import { send } from '@vercel/queue';
import { query } from './db';

export const RUNTIME_TOPIC = 'orvo-runtime';

export function validWorkspaceId(value:unknown):value is string{
  return typeof value==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

export async function publishRuntimeWake(workspaceId:string){
  if(!validWorkspaceId(workspaceId))throw new Error('Invalid workspace id for runtime queue.');
  if(!process.env.VERCEL)throw new Error('Vercel Queue is available only in a Vercel deployment.');
  // Generic wakes deliberately have no deduplication key: a later DB commit
  // must never be suppressed by an earlier wake for the same workspace.
  return send(RUNTIME_TOPIC,{workspaceId},{retentionSeconds:604800});
}

export async function reconcileRuntimeOutbox(){
  const workspaces=await query<{id:string}>(`SELECT id FROM workspaces w WHERE
    EXISTS(SELECT 1 FROM runtime_controls c WHERE c.workspace_id=w.id AND c.state IN ('pending','leased'))
    OR EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=w.id AND t.status IN ('queued','scheduled')
      AND (COALESCE(t.data->>'workflowRunId','')='' OR
        COALESCE(t.data->>'runtimeDispatchSentId','')<>COALESCE(t.data->>'workflowRunId','')))`);
  for(const {id} of workspaces.rows)await publishRuntimeWake(id);
  return {workspaces:workspaces.rows.length};
}
