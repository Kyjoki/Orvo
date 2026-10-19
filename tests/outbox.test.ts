import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ORVO_TEST_MODE='1';
delete process.env.DATABASE_URL;
delete process.env.ORVO_TEST_DB_DIR;
process.env.ORVO_TEST_DB_NAME=`outbox-${process.pid}-${randomUUID().slice(0,8)}`;
process.env.ORVO_WORKSPACE_ID=`outbox-${process.pid}`;

const domain=await import('../src/server/domain');
const { query, getDatabase }=await import('../src/server/db');
const { claimControl, settleControl, releaseControl }=await import('../src/server/runtime-outbox');
const workspace=await domain.getWorkspace();
after(async()=>{const database=await getDatabase();if(database.kind==='pglite')await database.db.close();});

test('outbox claim has one holder and an expired lease can be reclaimed',async()=>{
  await domain.command(workspace.id,'agents.seed',{},randomUUID());
  const agent=(await domain.getSnapshot(workspace.id)).agents[0];
  const task=await domain.command(workspace.id,'task.create',{title:'Lease fixture',agentId:agent.id},randomUUID());
  const controlId=randomUUID();
  await query('INSERT INTO runtime_controls(id,workspace_id,task_id,action,payload) VALUES($1,$2,$3,$4,$5)',
    [controlId,workspace.id,task.id,'resume',JSON.stringify({runtimeId:'run-one',requestId:'input-one'})]);

  const [first,second]=await Promise.all([claimControl(workspace.id),claimControl(workspace.id)]);
  const claimed=[first,second].filter(Boolean);
  assert.equal(claimed.length,1);
  assert.equal(claimed[0]?.id,controlId);
  assert.equal(await claimControl(workspace.id),undefined);

  await query("UPDATE runtime_controls SET lease_until=now()-interval '1 second' WHERE id=$1",[controlId]);
  const reclaimed=await claimControl(workspace.id);
  assert.equal(reclaimed?.id,controlId);
  assert.notEqual(reclaimed?.lease_token,claimed[0]?.lease_token);
  await settleControl(claimed[0]!,'delivered');
  assert.equal((await query('SELECT state FROM runtime_controls WHERE id=$1',[controlId])).rows[0].state,'leased');
  await settleControl(reclaimed!,'delivered');
  assert.equal((await query('SELECT state,attempts FROM runtime_controls WHERE id=$1',[controlId])).rows[0].state,'delivered');
  assert.equal((await query('SELECT state,attempts FROM runtime_controls WHERE id=$1',[controlId])).rows[0].attempts,2);
});

test('unbound cancel and resume are consumed without runtime delivery',async()=>{
  const agent=(await domain.getSnapshot(workspace.id)).agents[0];
  const task=await domain.command(workspace.id,'task.create',{title:'Unbound fixture',agentId:agent.id},randomUUID());
  await domain.commitRuntimeId(task.id,'fixture-run');
  const ids:string[]=[randomUUID(),randomUUID()];
  await query('INSERT INTO runtime_controls(id,workspace_id,task_id,action,payload) VALUES($1,$2,$3,$4,$5)',
    [ids[0],workspace.id,task.id,'cancel',JSON.stringify({})]);
  await query('INSERT INTO runtime_controls(id,workspace_id,task_id,action,payload) VALUES($1,$2,$3,$4,$5)',
    [ids[1],workspace.id,task.id,'resume',JSON.stringify({runtimeId:'fixture-run'})]);
  const {drainRuntime}=await import('../src/server/runtime-outbox');
  await drainRuntime(workspace.id);
  const states=(await query('SELECT id,state FROM runtime_controls WHERE id=ANY($1::text[])',[ids])).rows;
  assert.deepEqual(states.map((row:any)=>row.state).sort(),['consumed','consumed']);
});

test('released control can be reclaimed and an old holder cannot settle it',async()=>{
  const agent=(await domain.getSnapshot(workspace.id)).agents[0];
  const task=await domain.command(workspace.id,'task.create',{title:'Retry fixture',agentId:agent.id},randomUUID());
  const id=randomUUID();
  await query('INSERT INTO runtime_controls(id,workspace_id,task_id,action,payload) VALUES($1,$2,$3,$4,$5)',
    [id,workspace.id,task.id,'cancel',JSON.stringify({runtimeId:'run-one'})]);
  const first=await claimControl(workspace.id);
  assert.equal(first?.id,id);
  await releaseControl(first!);
  const second=await claimControl(workspace.id);
  assert.equal(second?.id,id);
  assert.notEqual(first?.lease_token,second?.lease_token);
  await settleControl(first!,'delivered');
  assert.equal((await query('SELECT state FROM runtime_controls WHERE id=$1',[id])).rows[0].state,'leased');
  await settleControl(second!,'delivered');
  assert.equal((await query('SELECT state FROM runtime_controls WHERE id=$1',[id])).rows[0].state,'delivered');
});

test('transient dispatch failure keeps the task queued and releases its lease',async()=>{
  const agent=(await domain.getSnapshot(workspace.id)).agents[0];
  const task=await domain.command(workspace.id,'task.create',{title:'Dispatch fixture',agentId:agent.id},randomUUID());
  await query("UPDATE tasks SET status='queued' WHERE id=$1",[task.id]);
  const {dispatchTask}=await import('../src/server/runtime');
  await assert.rejects(dispatchTask(task.id),/ORVO_RUNTIME_SECRET/);
  const row=(await query('SELECT status,dispatch_lease_token FROM tasks WHERE id=$1',[task.id])).rows[0];
  assert.equal(row.status,'queued');
  assert.equal(row.dispatch_lease_token,null);
  await query("UPDATE tasks SET status='failed' WHERE id=$1",[task.id]);
});

test('one failing control does not prevent another control attempt',async()=>{
  const agent=(await domain.getSnapshot(workspace.id)).agents[0];
  const tasks=[];
  for(let index=0;index<2;index++){
    const task=await domain.command(workspace.id,'task.create',{title:`Control failure ${index}`,agentId:agent.id},randomUUID());
    await domain.commitRuntimeId(task.id,`fixture-${randomUUID()}`);
    const id=randomUUID();
    await query('INSERT INTO runtime_controls(id,workspace_id,task_id,action,payload) VALUES($1,$2,$3,$4,$5)',
      [id,workspace.id,task.id,'cancel',JSON.stringify({runtimeId:`fixture-${index}`})]);
    tasks.push(id);
  }
  const prior=process.env.ORVO_RUNTIME_SECRET;
  delete process.env.ORVO_RUNTIME_SECRET;
  try{await assert.rejects((await import('../src/server/runtime-outbox')).drainRuntime(workspace.id),/unfinished work/);}
  finally{if(prior===undefined)delete process.env.ORVO_RUNTIME_SECRET;else process.env.ORVO_RUNTIME_SECRET=prior;}
  const controls=(await query('SELECT id,state,attempts FROM runtime_controls WHERE id=ANY($1::text[])',[tasks])).rows;
  assert.equal(controls.length,2);
  assert.ok(controls.every((row:any)=>row.state==='pending'&&row.attempts===1));
  await query("UPDATE runtime_controls SET state='consumed' WHERE id=ANY($1::text[])",[tasks]);
});

test('dispatch fence rejects lost token and uncertain send becomes visible without retry',async()=>{
  const agent=(await domain.getSnapshot(workspace.id)).agents[0];
  const task=await domain.command(workspace.id,'task.create',{title:'Uncertain send',agentId:agent.id},randomUUID());
  const runtimeId=`fixture-${randomUUID()}`;
  const token=randomUUID();
  await domain.commitRuntimeId(task.id,runtimeId);
  await query("UPDATE tasks SET status='queued',dispatch_lease_token=$2,dispatch_lease_until=now()+interval '120 seconds' WHERE id=$1",[task.id,token]);
  const {recordRuntimeDispatchState,markUncertainRuntimeDispatch}=await import('../src/server/runtime');
  await assert.rejects(recordRuntimeDispatchState(task.id,randomUUID(),runtimeId,'runtimeDispatchUncertainId'),/lease was lost/);
  assert.equal((await domain.getTask(task.id)).runtimeDispatchUncertainId,undefined);
  await recordRuntimeDispatchState(task.id,token,runtimeId,'runtimeDispatchUncertainId');
  assert.equal((await domain.getTask(task.id)).runtimeDispatchUncertainId,runtimeId);
  assert.equal((await markUncertainRuntimeDispatch(task.id,randomUUID(),runtimeId)).rows.length,0);
  assert.equal((await markUncertainRuntimeDispatch(task.id,token,runtimeId)).rows.length,1);
  const failed=await domain.getTask(task.id);
  assert.equal(failed.status,'failed');
  assert.match(failed.error,/ручная сверка/);
  await query("UPDATE tasks SET dispatch_lease_until=now()-interval '1 second' WHERE id=$1",[task.id]);
  await assert.rejects(recordRuntimeDispatchState(task.id,token,runtimeId,'runtimeDispatchSentId'),/lease was lost/);
});

test('executor progress before send acknowledgement is preserved',async()=>{
  const agent=(await domain.getSnapshot(workspace.id)).agents[0];
  const task=await domain.command(workspace.id,'task.create',{title:'Fast executor',agentId:agent.id},randomUUID());
  const runtimeId=`fixture-${randomUUID()}`,token=randomUUID();
  await domain.commitRuntimeId(task.id,runtimeId);
  await query("UPDATE tasks SET status='queued',dispatch_lease_token=$2,dispatch_lease_until=now()+interval '120 seconds' WHERE id=$1",[task.id,token]);
  const {recordRuntimeDispatchState,markUncertainRuntimeDispatch}=await import('../src/server/runtime');
  await recordRuntimeDispatchState(task.id,token,runtimeId,'runtimeDispatchUncertainId');
  await domain.setTaskStatus(task.id,'running');
  assert.equal((await markUncertainRuntimeDispatch(task.id,token,runtimeId)).rows.length,0);
  await recordRuntimeDispatchState(task.id,token,runtimeId,'runtimeDispatchSentId');
  assert.equal((await domain.getTask(task.id)).status,'running');
  assert.equal((await domain.getTask(task.id)).runtimeDispatchSentId,runtimeId);
  await domain.setTaskStatus(task.id,'failed');
});

test('a failed oldest control does not monopolize the next delivery',async()=>{
  const agent=(await domain.getSnapshot(workspace.id)).agents[0];
  const task=await domain.command(workspace.id,'task.create',{title:'Fairness fixture',agentId:agent.id},randomUUID());
  const ids:string[]=[randomUUID(),randomUUID()];
  for(const id of ids)await query('INSERT INTO runtime_controls(id,workspace_id,task_id,action,payload) VALUES($1,$2,$3,$4,$5)',
    [id,workspace.id,task.id,'cancel',JSON.stringify({runtimeId:'fixture'})]);
  const first=await claimControl(workspace.id);
  assert.ok(first&&ids.includes(first.id));
  await releaseControl(first!);
  const second=await claimControl(workspace.id);
  assert.ok(second&&ids.includes(second.id));
  assert.notEqual(second.id,first?.id);
  await settleControl(second!,'consumed');
  await query("UPDATE runtime_controls SET state='consumed' WHERE id=$1",[first!.id]);
});
