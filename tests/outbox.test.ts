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
const { claimControl, settleControl }=await import('../src/server/runtime-outbox');
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
  const ids=[randomUUID(),randomUUID()];
  await query('INSERT INTO runtime_controls(id,workspace_id,task_id,action,payload) VALUES($1,$2,$3,$4,$5)',
    [ids[0],workspace.id,task.id,'cancel',JSON.stringify({})]);
  await query('INSERT INTO runtime_controls(id,workspace_id,task_id,action,payload) VALUES($1,$2,$3,$4,$5)',
    [ids[1],workspace.id,task.id,'resume',JSON.stringify({runtimeId:'fixture-run'})]);
  const {drainRuntime}=await import('../src/server/runtime-outbox');
  await drainRuntime(workspace.id);
  const states=(await query('SELECT id,state FROM runtime_controls WHERE id=ANY($1::text[])',[ids])).rows;
  assert.deepEqual(states.map((row:any)=>row.state).sort(),['consumed','consumed']);
});
