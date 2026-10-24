import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
process.env.ORVO_TEST_MODE='1';
delete process.env.DATABASE_URL;
delete process.env.ORVO_TEST_DB_DIR;
process.env.ORVO_TEST_DB_NAME=`domain-${process.pid}-${randomUUID().slice(0,8)}`;
process.env.ORVO_WORKSPACE_ID=`test-${process.pid}`;
const domain=await import('../src/server/domain');
const {query,getDatabase}=await import('../src/server/db');
const workspace=await domain.getWorkspace();
const cmd=(type:string,payload:any={},requestId=randomUUID())=>domain.command(workspace.id,type,payload,requestId);
let agentIds:string[]=[];
after(async()=>{const database=await getDatabase();if(database.kind==='pglite')await database.db.close();});

test('12 unique profiles; repeat seed preserves owner instructions and separate memory',async()=>{
  await cmd('agents.seed');let snapshot=await domain.getSnapshot(workspace.id);assert.equal(snapshot.agents.length,12);assert.equal(new Set(snapshot.agents.map((a:any)=>a.roleKey)).size,12);assert.equal(new Set(snapshot.agents.map((a:any)=>a.id)).size,12);
  agentIds=snapshot.agents.map((a:any)=>a.id);await cmd('agents.update',{id:agentIds[0],name:'Владелец изменил имя'});await cmd('instructions.save',{agentId:agentIds[0],text:'Собственные инструкции владельца'});await cmd('memory.save',{scope:'agent',agentId:agentIds[0],text:'Правило первого агента'});await cmd('agents.seed');snapshot=await domain.getSnapshot(workspace.id);assert.equal(snapshot.agents.length,12);assert.equal(snapshot.agents.find((a:any)=>a.id===agentIds[0]).name,'Владелец изменил имя');assert.equal(snapshot.agents.find((a:any)=>a.id===agentIds[0]).instructionVersion,2);assert.equal(snapshot.memories.length,1);
});
test('no configured model starts no execution; ordinary chat persists only once',async()=>{
  const result=await cmd('task.create',{title:'Без модели',agentId:agentIds[0]});assert.equal(result.status,'waiting_for_input');assert.deepEqual(result.dispatchTaskIds,[]);
  const requestId=randomUUID();const first=await cmd('chat.send',{agentId:agentIds[0],text:'Обычное сообщение'},requestId);const second=await cmd('chat.send',{agentId:agentIds[0],text:'Обычное сообщение'},requestId);assert.equal(first.id,second.id);assert.equal(first.executionStarted,false);assert.equal((await domain.getSnapshot(workspace.id)).messages.length,1);
});
test('creation idempotency, payload conflict and server claims protect concurrency',async()=>{
  await cmd('settings.save',{provider:'test',model:'test/deterministic'});await domain.recordModelCheck(workspace.id,{ok:true,model:'test/deterministic'});
  const requestId=randomUUID(),payload={title:'Проверка конкурентных запросов',agentId:agentIds[0]};const [a,b]=await Promise.all([cmd('task.create',payload,requestId),cmd('task.create',payload,requestId)]);assert.equal(a.id,b.id);
  await assert.rejects(cmd('task.create',{...payload,title:'Другие параметры'},requestId),(e:any)=>e.code==='IDEMPOTENCY_CONFLICT');
  const sibling=await cmd('task.create',{title:'Один агент',agentId:agentIds[0]}),other=await cmd('task.create',{title:'Второй агент',agentId:agentIds[1]}),third=await cmd('task.create',{title:'Третий агент',agentId:agentIds[2]});
  assert.equal(await domain.claimTask(a.id),true);assert.equal(await domain.claimTask(a.id),false);assert.equal(await domain.claimTask(sibling.id),false);assert.equal(await domain.claimTask(other.id),true);assert.equal(await domain.claimTask(third.id),false);
  await domain.setTaskStatus(a.id,'cancelled');await domain.setTaskStatus(other.id,'cancelled');assert.equal(await domain.claimTask(third.id),true);await domain.setTaskStatus(third.id,'cancelled');
});
test('memory scopes and revoked records do not leak between agents/workspaces',async()=>{
  await cmd('memory.save',{scope:'workspace',text:'Общее правило пространства'});const deleted=await cmd('memory.save',{scope:'agent',agentId:agentIds[0],text:'Удалённое правило'});await cmd('memory.delete',{id:deleted.id});
  const a=await cmd('task.create',{title:'Первый контекст',agentId:agentIds[0]}),b=await cmd('task.create',{title:'Второй контекст',agentId:agentIds[1]});
  const first=await domain.prepareTask(a.id),second=await domain.prepareTask(b.id);assert(first.memories.some((m:any)=>m.text==='Правило первого агента'));assert(!second.memories.some((m:any)=>m.text==='Правило первого агента'));assert(second.memories.some((m:any)=>m.text==='Общее правило пространства'));assert(!first.memories.some((m:any)=>m.text==='Удалённое правило'));
  await assert.rejects(domain.command('unknown','agents.update',{id:agentIds[0],name:'Нарушитель'},randomUUID()),(e:any)=>e.code==='NOT_FOUND');
});
test('approval binds immutable params, applies once and cancel revokes authority',async()=>{
  const task=await cmd('task.create',{title:'Подтверждение',agentId:agentIds[3]});assert(await domain.claimTask(task.id));const approval=await domain.createApproval(task.id,{text:'Правило после подтверждения'});const same=await domain.createApproval(task.id,{text:'Правило после подтверждения'});assert.equal(approval.id,same.id);
  await cmd('approval.decide',{id:approval.id,version:approval.version,decision:'approve'});await assert.rejects(cmd('approval.decide',{id:approval.id,decision:'approve'}),(e:any)=>e.code==='APPROVAL_CONFLICT');
  assert.equal((await domain.getSnapshot(workspace.id)).memories.filter((m:any)=>m.text==='Правило после подтверждения').length,1);
  const cancelled=await cmd('task.create',{title:'Отмена подтверждения',agentId:agentIds[4]});assert(await domain.claimTask(cancelled.id));const revoked=await domain.createApproval(cancelled.id,{text:'Не сохранять'});await cmd('task.cancel',{id:cancelled.id});await assert.rejects(cmd('approval.decide',{id:revoked.id,decision:'approve'}),(e:any)=>e.code==='APPROVAL_CONFLICT');
  const stale=await cmd('task.create',{title:'Устаревшее подтверждение',agentId:agentIds[5]});assert(await domain.claimTask(stale.id));const old=await domain.createApproval(stale.id,{text:'Не сохранять устаревшее'});await domain.setTaskStatus(stale.id,'waiting_for_approval',{changed:true});await assert.rejects(cmd('approval.decide',{id:old.id,decision:'approve'}),(e:any)=>e.code==='STALE_APPROVAL');await cmd('task.cancel',{id:stale.id});
});
test('atomic reservation rejects budget races, progress and result versions survive commands',async()=>{
  const task=await cmd('task.create',{title:'Ограниченный бюджет',agentId:agentIds[6],maxTokens:1000});assert(await domain.claimTask(task.id));
  const results=await Promise.allSettled([domain.reserveUsage(task.id,400,300,'test/deterministic'),domain.reserveUsage(task.id,400,300,'test/deterministic')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const reservation=(results.find(r=>r.status==='fulfilled')as PromiseFulfilledResult<string>).value;await domain.settleUsage(reservation,{inputTokens:20,outputTokens:30});
  const first=await domain.saveResult(task.id,'# Реально сохранённый Markdown');const duplicate=await domain.saveResult(task.id,'# Реально сохранённый Markdown');assert.equal(first?.id,duplicate?.id);await cmd('task.revise',{id:task.id,comment:'Добавить ограничения'});assert(await domain.claimTask(task.id));const revised=await domain.saveResult(task.id,'# Новая версия с ограничениями');assert.equal(revised?.version,2);await cmd('task.accept',{id:task.id});assert.equal((await domain.getTask(task.id)).status,'completed');const artifacts=(await domain.getSnapshot(workspace.id)).artifacts.filter((a:any)=>a.taskId===task.id);assert.equal(artifacts.length,2);assert.equal(artifacts[1].accepted,true);
});
test('active archive conflict and restricted tools are enforced on server',async()=>{
  const task=await cmd('task.create',{title:'Проверка архива',agentId:agentIds[8]});await assert.rejects(cmd('agents.archive',{id:agentIds[8]}),(e:any)=>e.code==='AGENT_BUSY');await cmd('task.cancel',{id:task.id});await cmd('agents.archive',{id:agentIds[8]});await assert.rejects(cmd('task.create',{title:'Не запускать архив',agentId:agentIds[8]}),(e:any)=>e.code==='AGENT_ARCHIVED');await assert.rejects(cmd('agents.update',{id:agentIds[1],permissions:{shell:'allow'}}),(e:any)=>e.code==='TOOL_UNAVAILABLE');await assert.rejects(cmd('memory.save',{scope:'workspace',text:'api_key=very-secret-value'}),(e:any)=>e.code==='SECRET_REJECTED');
});
test('durable claim replay is owner-bound; pause preserves paid result for resume',async()=>{
  const task=await cmd('task.create',{title:'Пауза на границе результата',agentId:agentIds[10]});await domain.commitRuntimeId(task.id,'run-original');assert.equal(await domain.commitRuntimeId(task.id,'run-duplicate'),false);assert(await domain.claimTask(task.id,'run-original'));assert(await domain.claimTask(task.id,'run-original'));assert.equal(await domain.claimTask(task.id,'run-duplicate'),false);
  await cmd('task.pause',{id:task.id});assert.equal((await domain.getTask(task.id)).status,'pause_requested');await domain.saveResult(task.id,'# Уже оплаченный результат текущего шага');assert.equal((await domain.getTask(task.id)).status,'paused');await cmd('task.resume',{id:task.id});assert.equal((await domain.getTask(task.id)).status,'ready_for_review');assert.equal((await domain.getTask(task.id)).workflowRunId,'run-original');const artifacts=(await domain.getSnapshot(workspace.id)).artifacts.filter((a:any)=>a.taskId===task.id);assert.equal(artifacts.length,1);assert.equal(artifacts[0].text,'# Уже оплаченный результат текущего шага');
});
test('model names cannot self-authorize a connection or another agent context',async()=>{
  await cmd('settings.save',{model:'test/unverified',modelChecked:true,checkedModels:['test/unverified']});const task=await cmd('task.create',{title:'Непроверенная модель',agentId:agentIds[11]});assert.equal(task.setupRequired,true);assert.deepEqual(task.dispatchTaskIds,[]);await assert.rejects(cmd('task.start',{id:task.id}),(e:any)=>e.code==='MODEL_NOT_CONFIGURED');await assert.rejects(domain.prepareTask(task.id,agentIds[1]),(e:any)=>e.code==='CONTEXT_AGENT_DENIED');
});

test('an unknown runtime send cannot be restarted by an owner command',async()=>{
  await cmd('settings.save',{provider:'test',model:'test/deterministic'});
  await domain.recordModelCheck(workspace.id,{ok:true,model:'test/deterministic'});
  const task=await cmd('task.create',{title:'Неизвестный исход отправки',agentId:agentIds[11]});
  await domain.setTaskStatus(task.id,'failed',{workflowRunId:'uncertain-run',runtimeDispatchUncertainId:'uncertain-run',runtimeDispatchSentId:null});
  await assert.rejects(cmd('task.retry',{id:task.id}),(error:any)=>error.code==='RUNTIME_RECONCILIATION_REQUIRED');
  assert.equal((await domain.getTask(task.id)).workflowRunId,'uncertain-run');
  const revise=await cmd('task.create',{title:'Неизвестный исход при правке',agentId:agentIds[11]});
  await domain.setTaskStatus(revise.id,'running');
  await domain.setTaskStatus(revise.id,'ready_for_review',{workflowRunId:'uncertain-run',runtimeDispatchUncertainId:'uncertain-run'});
  await assert.rejects(cmd('task.revise',{id:revise.id,comment:'Повторить'}),(error:any)=>error.code==='RUNTIME_RECONCILIATION_REQUIRED');
  const start=await cmd('task.create',{title:'Неизвестный исход при запуске',agentId:agentIds[11],draft:true});
  await query("UPDATE tasks SET status='waiting_for_input',data=data || $2::jsonb WHERE id=$1",[start.id,JSON.stringify({workflowRunId:'uncertain-run',runtimeDispatchUncertainId:'uncertain-run'})]);
  await assert.rejects(cmd('task.start',{id:start.id}),(error:any)=>error.code==='RUNTIME_RECONCILIATION_REQUIRED');
});

test('owner can create, switch and rename an isolated startup office',async()=>{
  const ownerId=`owner-${randomUUID()}`;
  await query('INSERT INTO owners(id,workspace_id,email) VALUES($1,$2,$3)',[ownerId,workspace.id,`${ownerId}@example.test`]);
  await query('INSERT INTO workspace_owners(owner_id,workspace_id) VALUES($1,$2)',[ownerId,workspace.id]);
  const before=await domain.getSnapshot(workspace.id);
  const created=await domain.createOwnerWorkspace(ownerId,'Моя студия');
  assert.equal(created.name,'Моя студия');
  assert.equal(created.officeDesign,'studio');
  assert.notEqual(created.id,workspace.id);
  assert.deepEqual((await domain.getSnapshot(created.id)).agents,[]);
  await query('INSERT INTO agents(id,workspace_id,role_key,data) VALUES($1,$2,$3,$4)',[randomUUID(),created.id,'startup-test',JSON.stringify({name:'Тестовый агент'})]);
  assert.equal((await domain.getSnapshot(created.id)).agents.length,1);
  assert.equal((await domain.getSnapshot(workspace.id)).agents.length,before.agents.length);
  const renamed=await domain.renameOwnerWorkspace(ownerId,created.id,'Название стартапа');
  assert.equal(renamed.name,'Название стартапа');
  assert.deepEqual((await domain.listOwnerWorkspaces(ownerId)).map((office:any)=>office.name),[workspace.name,'Название стартапа']);
  await assert.rejects(domain.getWorkspaceForOwner(ownerId,'not-this-owners-office'),(error:any)=>error.code==='FORBIDDEN');
});
