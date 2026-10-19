import { randomUUID } from 'node:crypto';
import { query, transaction } from './db';
import { dispatchTask, controlRuntime } from './runtime';

const LEASE_SECONDS = 120;
const RENEW_INTERVAL_MS = 30_000;
const STALE_CODES = new Set(['STALE_RUNTIME_INPUT', 'STALE_RUNTIME_CONTROL', 'APPROVAL_INPUT_MISMATCH', 'RUNTIME_INPUT_MISMATCH', 'RUNTIME_INPUT_REQUIRED']);
type Control = { id:string; task_id:string; action:string; payload:Record<string,unknown>; lease_token:string };

let active:Promise<void>|undefined;
export function drainRuntime(workspaceId:string){
  return active??=drain(workspaceId).finally(()=>{active=undefined;});
}

// The row lock and lease are shared by every Next process, unlike the local
// `active` optimization above. A crashed worker's claim becomes available again.
export async function claimControl(workspaceId:string):Promise<Control|undefined>{
  return transaction(async db=>{
    const row=(await db.query<Control>(
      `SELECT * FROM runtime_controls
       WHERE workspace_id=$1 AND (state='pending' OR (state='leased' AND lease_until<now()))
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,[workspaceId]
    )).rows[0];
    if(!row)return undefined;
    const token=randomUUID();
    return (await db.query<Control>(
      `UPDATE runtime_controls SET state='leased',lease_token=$2,
       lease_until=now()+($3 * interval '1 second'),attempts=attempts+1
       WHERE id=$1 RETURNING *`,[row.id,token,LEASE_SECONDS]
    )).rows[0];
  });
}

async function renew(control:Control){
  await query(
    `UPDATE runtime_controls SET lease_until=now()+($3 * interval '1 second')
     WHERE id=$1 AND lease_token=$2 AND state='leased'`,
    [control.id,control.lease_token,LEASE_SECONDS]
  );
}

export async function settleControl(control:Control,state:'delivered'|'consumed'){
  await query(
    `UPDATE runtime_controls SET state=$3,lease_token=NULL,lease_until=NULL
     WHERE id=$1 AND lease_token=$2 AND state='leased'`,
    [control.id,control.lease_token,state]
  );
}

function hasExactBinding(control:Control){
  const payload=control.payload;
  if(control.action==='pause')return true; // No runtime input is sent.
  if(control.action==='cancel')return typeof payload.runtimeId==='string'&&payload.runtimeId.length>0;
  if(control.action==='resume')return typeof payload.runtimeId==='string'&&payload.runtimeId.length>0&&
    (payload.domainOnly===true||(typeof payload.requestId==='string'&&payload.requestId.length>0));
  if(control.action==='approve'||control.action==='reject')return typeof payload.runtimeId==='string'&&payload.runtimeId.length>0&&
    typeof payload.requestId==='string'&&payload.requestId.length>0&&typeof payload.approvalId==='string'&&payload.approvalId.length>0;
  return false;
}

async function deliver(control:Control){
  if(!hasExactBinding(control)){await settleControl(control,'consumed');return;}
  const heartbeat=setInterval(()=>{void renew(control).catch(()=>{});},RENEW_INTERVAL_MS);
  heartbeat.unref?.();
  try {
    const result=await controlRuntime(control.task_id,control.action,control.payload);
    // A task cancelled before its runtime starts has no action to deliver.
    await settleControl(control,result.accepted?'delivered':'consumed');
  } catch(error){
    if(STALE_CODES.has((error as {code?:string}).code||''))await settleControl(control,'consumed');
    // Other errors retain the lease. A later drain retries after expiry.
  } finally {clearInterval(heartbeat);}
}

async function drain(workspaceId:string){
  for(let index=0;index<20;index++){
    const control=await claimControl(workspaceId);
    if(!control)break;
    await deliver(control);
  }
  const tasks=(await query("SELECT id FROM tasks WHERE workspace_id=$1 AND status IN ('queued','scheduled') AND COALESCE(data->>'workflowRunId','')='' ORDER BY created_at LIMIT 2",[workspaceId])).rows;
  for(const task of tasks){try{await dispatchTask(task.id);}catch{/* dispatch records a safe domain error; the durable task remains inspectable. */}}
}
