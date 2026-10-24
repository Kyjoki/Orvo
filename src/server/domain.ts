import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { query, transaction, type Queryable } from './db';
import { insertTeam } from './seed';
import {currentAgentTask} from '../shared/agent-state';
import { DomainError, TASK_STATUSES, type TaskStatus, type Task } from '../shared/types';
export { seedTeam } from './seed';

const id=()=>randomUUID();
const now=()=>new Date().toISOString();
const json=(value:any)=>JSON.stringify(value);
const active=['queued','scheduled','running','pause_requested','paused','waiting_for_input','waiting_for_approval','retry_scheduled','cancel_requested'];
const terminal=['cancelled','completed','failed'];
const transitions:Record<string,string[]>={draft:['queued','cancelled'],scheduled:['queued','running','paused','cancelled','failed'],queued:['running','paused','cancelled','failed'],running:['waiting_for_input','waiting_for_approval','pause_requested','paused','cancel_requested','cancelled','retry_scheduled','ready_for_review','failed'],waiting_for_input:['queued','paused','cancelled','failed'],waiting_for_approval:['queued','cancelled','failed'],pause_requested:['paused','cancel_requested','cancelled','failed'],paused:['queued','ready_for_review','cancelled','failed'],retry_scheduled:['queued','running','paused','cancelled','failed'],ready_for_review:['completed','queued','cancelled'],completed:[],failed:['queued','cancelled'],cancel_requested:['cancelled'],cancelled:[]};
const secretPattern=/(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*\S+)/i;
const text=(value:unknown,max=50000)=>{const v=z.string().min(1).max(max).parse(value);if(secretPattern.test(v))throw new DomainError('SECRET_REJECTED','Не сохраняйте API-ключи и секреты в данных Orvo.');return v;};
const serialize=(row:any)=>({...row.data,id:row.id,workspaceId:row.workspace_id,version:row.version??row.data?.version??1,...(row.agent_id?{agentId:row.agent_id}:{}),...(row.task_id?{taskId:row.task_id}:{}),...(row.status?{status:row.status}:{}),...(row.role_key?{roleKey:row.role_key}:{}),...(typeof row.archived==='boolean'?{archived:row.archived}:{}),...(typeof row.active==='boolean'?{active:row.active}:{}),...(row.scope?{scope:row.scope}:{}),...(row.project_id?{projectId:row.project_id}:{}),createdAt:row.created_at,updatedAt:row.updated_at??row.created_at});
function assert(condition:any,code:string,message:string,status=409):asserts condition{if(!condition)throw new DomainError(code,message,status);}
async function workspaceLock(db:Queryable,workspaceId:string){const result=await db.query('SELECT * FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);assert(result.rows[0],'NOT_FOUND','Пространство не найдено.',404);return result.rows[0];}
async function owned(db:Queryable,table:string,workspaceId:string,itemId:string){
  // Table identifiers are server constants, never request strings.
  assert(['agents','tasks','memories','approvals','artifacts','attachments','projects'].includes(table),'INTERNAL','Неизвестная сущность.');
  const result=await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,itemId]);assert(result.rows[0],'NOT_FOUND','Запись не найдена в текущем пространстве.',404);return result.rows[0];
}
function version(row:any,expected:any){if(expected!==undefined)assert(row.version===Number(expected),'VERSION_CONFLICT','Данные уже изменились. Обновите страницу.');}
async function audit(db:Queryable,workspaceId:string,type:string,data:any={},taskId:string|null=null){const safe={...data};delete safe.text;delete safe.description;await db.query('INSERT INTO audit_events(id,workspace_id,task_id,type,data) VALUES($1,$2,$3,$4,$5)',[id(),workspaceId,taskId,type,json(safe)]);}
async function notify(db:Queryable,workspaceId:string,taskId:string,kind:string,title:string){await db.query('INSERT INTO notifications(id,workspace_id,task_id,kind,data) VALUES($1,$2,$3,$4,$5)',[id(),workspaceId,taskId,kind,json({title})]);}
function hasCredential(provider:string){return provider==='test'?process.env.ORVO_TEST_MODE==='1':provider==='openai'?!!process.env.OPENAI_API_KEY:provider==='gateway'?!!process.env.AI_GATEWAY_API_KEY:false;}
function configured(settings:any,agent:any){const model=agent.model||settings.model;return !!model&&Array.isArray(settings.checkedModels)&&settings.checkedModels.includes(model)&&hasCredential(settings.provider);}
function safeSettings(settings:any){return {...settings,credentialsConfigured:hasCredential(settings.provider),testMode:process.env.ORVO_TEST_MODE==='1'};}
export async function getWorkspace(){
  const workspaceId=process.env.ORVO_WORKSPACE_ID||'orvo-personal';
  const settings={name:'Владелец Orvo',timezone:'Asia/Qyzylorda',provider:'gateway',model:'',maxTokens:200000,maxTaskTokens:24000,maxOutputTokens:3000,maxSteps:10,maxConcurrentTasks:2,theme:'dark'};
  await query('INSERT INTO workspaces(id,name,settings) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[workspaceId,'Orvo',json(settings)]);
  const row=(await query('SELECT * FROM workspaces WHERE id=$1',[workspaceId])).rows[0];return {id:row.id,name:row.name,ownerId:row.settings.ownerId||null,version:row.version,settings:safeSettings(row.settings)};
}
function workspaceRecord(row:any,ownerId:string){return{id:row.id,name:row.name,ownerId,version:row.version,officeDesign:row.settings?.officeDesign==='studio'?'studio':'classic',settings:safeSettings(row.settings||{})};}
export async function getWorkspaceForOwner(ownerId:string,requestedId?:string|null){
  const result=await query(`SELECT w.* FROM workspace_owners wo JOIN workspaces w ON w.id=wo.workspace_id WHERE wo.owner_id=$1 AND w.archived_at IS NULL AND ($2::text IS NULL OR w.id=$2) ORDER BY wo.created_at ASC LIMIT 1`,[ownerId,requestedId||null]);
  let row=result.rows[0];
  if(!row){const primary=(await query('SELECT w.* FROM owners o JOIN workspaces w ON w.id=o.workspace_id WHERE o.id=$1 AND w.archived_at IS NULL',[ownerId])).rows[0];if(primary&&(!requestedId||requestedId===primary.id))row=primary;}
  assert(row,'FORBIDDEN','Нет доступа к этому офису.',403);return workspaceRecord(row,ownerId);
}
export async function listOwnerWorkspaces(ownerId:string){
  const result=await query(`SELECT w.id,w.name,w.settings->>'officeDesign' AS office_design,w.created_at FROM workspace_owners wo JOIN workspaces w ON w.id=wo.workspace_id WHERE wo.owner_id=$1 AND w.archived_at IS NULL ORDER BY wo.created_at ASC`,[ownerId]);
  if(result.rows.length)return result.rows.map((row:any)=>({id:row.id,name:row.name,officeDesign:row.office_design==='studio'?'studio':'classic',createdAt:row.created_at}));
  const primary=(await query('SELECT w.id,w.name,w.settings->>\'officeDesign\' AS office_design,w.created_at FROM owners o JOIN workspaces w ON w.id=o.workspace_id WHERE o.id=$1 AND w.archived_at IS NULL',[ownerId])).rows;
  return primary.map((row:any)=>({id:row.id,name:row.name,officeDesign:row.office_design==='studio'?'studio':'classic',createdAt:row.created_at}));
}
export async function listArchivedOwnerWorkspaces(ownerId:string){
  const rows=(await query(`SELECT w.id,w.name,w.settings->>'officeDesign' AS office_design,w.created_at
    FROM workspace_owners wo JOIN workspaces w ON w.id=wo.workspace_id
    WHERE wo.owner_id=$1 AND w.archived_at IS NOT NULL ORDER BY w.archived_at DESC`,[ownerId])).rows;
  return rows.map((row:any)=>({id:row.id,name:row.name,officeDesign:row.office_design==='studio'?'studio':'classic',createdAt:row.created_at}));
}
export async function createOwnerWorkspace(ownerId:string,name:string){
  const cleanName=text(name.trim(),60);const newId=id();
  await transaction(async db=>{
    const owner=(await db.query('SELECT * FROM owners WHERE id=$1 FOR UPDATE',[ownerId])).rows[0];assert(owner,'FORBIDDEN','Владелец не найден.',403);
    const count=(await db.query('SELECT count(*)::int AS count FROM workspace_owners WHERE owner_id=$1',[ownerId])).rows[0]?.count||0;assert(count<20,'OFFICE_LIMIT','Можно создать не больше 20 офисов.',400);
    const source=(await db.query('SELECT w.settings FROM workspaces w WHERE w.id=$1',[owner.workspace_id])).rows[0]?.settings||{};
    const settings={...source,ownerId,officeDesign:'studio',model:'',checkedModels:[],modelChecked:false,modelCheckAt:null,modelCheckError:null};
    await db.query('INSERT INTO workspaces(id,name,settings) VALUES($1,$2,$3)',[newId,cleanName,json(settings)]);
    await db.query('INSERT INTO workspace_owners(owner_id,workspace_id) VALUES($1,$2)',[ownerId,newId]);
  });
  return getWorkspaceForOwner(ownerId,newId);
}
export async function renameOwnerWorkspace(ownerId:string,workspaceId:string,name:string){
  const cleanName=text(name.trim(),60);
  await transaction(async db=>{const membership=await db.query('SELECT 1 FROM workspace_owners WHERE owner_id=$1 AND workspace_id=$2 FOR UPDATE',[ownerId,workspaceId]);assert(membership.rows[0],'FORBIDDEN','Нет доступа к этому офису.',403);await db.query('UPDATE workspaces SET name=$1,version=version+1 WHERE id=$2',[cleanName,workspaceId]);});
  return getWorkspaceForOwner(ownerId,workspaceId);
}
export async function archiveOwnerWorkspace(ownerId:string,workspaceId:string,confirmName:string){
  return transaction(async db=>{
    const owner=(await db.query('SELECT workspace_id FROM owners WHERE id=$1 FOR UPDATE',[ownerId])).rows[0];
    assert(owner,'FORBIDDEN','Владелец не найден.',403);
    const membership=await db.query('SELECT 1 FROM workspace_owners WHERE owner_id=$1 AND workspace_id=$2 FOR UPDATE',[ownerId,workspaceId]);
    assert(membership.rows[0],'FORBIDDEN','Нет доступа к этому офису.',403);
    assert(owner.workspace_id!==workspaceId,'PRIMARY_OFFICE','Основной офис владельца нельзя убрать в архив.',409);
    const offices=(await db.query(`SELECT w.id FROM workspace_owners wo JOIN workspaces w ON w.id=wo.workspace_id
      WHERE wo.owner_id=$1 AND w.archived_at IS NULL FOR UPDATE OF w`,[ownerId])).rows;
    assert(offices.length>1,'LAST_OFFICE','Нельзя убрать последний офис.',409);
    const office=(await db.query('SELECT name,archived_at FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId])).rows[0];
    assert(office,'NOT_FOUND','Офис не найден.',404);
    assert(!office.archived_at,'OFFICE_ALREADY_ARCHIVED','Этот офис уже в архиве.',409);
    assert(confirmName===office.name,'OFFICE_NAME_MISMATCH','Название не совпадает. Офис не перемещён.',400);
    await db.query('UPDATE workspaces SET archived_at=now(),version=version+1 WHERE id=$1',[workspaceId]);
  });
}
export async function restoreOwnerWorkspace(ownerId:string,workspaceId:string){
  await transaction(async db=>{
    const owner=(await db.query('SELECT id FROM owners WHERE id=$1 FOR UPDATE',[ownerId])).rows[0];
    assert(owner,'FORBIDDEN','Владелец не найден.',403);
    const membership=await db.query('SELECT 1 FROM workspace_owners WHERE owner_id=$1 AND workspace_id=$2 FOR UPDATE',[ownerId,workspaceId]);
    assert(membership.rows[0],'FORBIDDEN','Нет доступа к этому офису.',403);
    const result=await db.query('UPDATE workspaces SET archived_at=NULL,version=version+1 WHERE id=$1 AND archived_at IS NOT NULL',[workspaceId]);
    assert(result.rowCount,'NOT_FOUND','Архивный офис не найден.',404);
  });
  return getWorkspaceForOwner(ownerId,workspaceId);
}
export async function permanentlyDeleteArchivedWorkspace(ownerId:string,workspaceId:string,confirmName:string){
  await transaction(async db=>{
    const owner=(await db.query('SELECT workspace_id FROM owners WHERE id=$1 FOR UPDATE',[ownerId])).rows[0];
    assert(owner,'FORBIDDEN','Владелец не найден.',403);
    const membership=await db.query('SELECT 1 FROM workspace_owners WHERE owner_id=$1 AND workspace_id=$2 FOR UPDATE',[ownerId,workspaceId]);
    assert(membership.rows[0],'FORBIDDEN','Нет доступа к этому офису.',403);
    assert(owner.workspace_id!==workspaceId,'PRIMARY_OFFICE','Основной офис удалить нельзя.',409);
    const office=(await db.query('SELECT name,archived_at FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId])).rows[0];
    assert(office,'NOT_FOUND','Офис не найден.',404);
    assert(office.archived_at,'OFFICE_NOT_ARCHIVED','Сначала переместите офис в архив.',409);
    assert(confirmName===office.name,'OFFICE_NAME_MISMATCH','Название не совпадает. Офис не удалён.',400);
    const running=(await db.query('SELECT count(*)::int AS count FROM tasks WHERE workspace_id=$1 AND status=ANY($2::text[])',[workspaceId,active])).rows[0]?.count||0;
    assert(running===0,'OFFICE_HAS_ACTIVE_TASKS','В архивном офисе ещё есть активные задачи. Завершите или отмените их перед удалением.',409);

    // Permanent purge is restricted to archived, owner-scoped offices and runs atomically.
    for(const table of ['runtime_controls','task_runs','task_steps','messages','approvals','artifacts','usage_entries','attachments','notifications','audit_events','watch_alert_outbox','watch_candidate_reviews','watch_feedback','watch_analysis_events','watch_analysis_usage','watch_connections','telegram_connections','command_requests','model_checks','instruction_versions','memories','tasks','projects','agents']){
      await db.query(`DELETE FROM ${table} WHERE workspace_id=$1`,[workspaceId]);
    }
    await db.query('DELETE FROM workspace_owners WHERE owner_id=$1 AND workspace_id=$2',[ownerId,workspaceId]);
    await db.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);
  });
}
export async function bindWorkspaceOwner(ownerId:string,email:string){const w=await getWorkspace();return transaction(async db=>{const row=await workspaceLock(db,w.id);assert(!row.settings.ownerId||row.settings.ownerId===ownerId,'OWNER_ALREADY_CONFIGURED','Владелец пространства уже настроен.');await db.query('INSERT INTO owners(id,workspace_id,email) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[ownerId,w.id,email]);await db.query('UPDATE workspaces SET settings=$1,version=version+1 WHERE id=$2',[json({...row.settings,ownerId}),w.id]);await db.query('INSERT INTO workspace_owners(owner_id,workspace_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[ownerId,w.id]);return{id:w.id,ownerId};});}
export async function recordModelCheck(workspaceId:string,result:{ok:boolean;model:string;error?:string}){return transaction(async db=>{const w=await workspaceLock(db,workspaceId);const checkedModels=new Set<string>(w.settings.checkedModels||[]);if(result.ok)checkedModels.add(result.model);else checkedModels.delete(result.model);const settings={...w.settings,checkedModels:[...checkedModels],modelChecked:result.ok,modelCheckAt:now(),modelCheckError:result.ok?null:'Подключение модели не подтверждено. Проверьте серверные настройки.'};await db.query('UPDATE workspaces SET settings=$1,version=version+1 WHERE id=$2',[json(settings),workspaceId]);await audit(db,workspaceId,'model.checked',{ok:result.ok,model:result.model});return safeSettings(settings);});}
export async function getSnapshot(workspaceId:string){
  const w=(await query('SELECT * FROM workspaces WHERE id=$1',[workspaceId])).rows[0];assert(w,'NOT_FOUND','Пространство не найдено.',404);
  const tables=['agents','tasks','memories','messages','approvals','artifacts','notifications','audit_events','usage_entries','attachments','projects','task_steps'];
  const results=await Promise.all(tables.map(table=>query(`SELECT * FROM ${table} WHERE workspace_id=$1 ORDER BY created_at ASC LIMIT 1000`,[workspaceId])));
  const rows=Object.fromEntries(tables.map((table,index)=>[table,results[index].rows]));
  const tasks=rows.tasks.map((row:any)=>({...serialize(row),steps:rows.task_steps.filter((s:any)=>s.task_id===row.id).map((s:any)=>{const v=serialize(s);delete v.text;return v;})}));
  const agents=rows.agents.map((row:any)=>{const a=serialize(row);const current=currentAgentTask(tasks,a.id);return {...a,status:a.archived?'archived':current?.status||(!configured(w.settings,a)?'requires_setup':'idle'),currentTask:current?.id||null,queueLength:tasks.filter((t:any)=>t.agentId===a.id&&t.status==='queued').length};});
  const ownerId=w.settings.ownerId||(await query('SELECT id FROM owners WHERE workspace_id=$1',[workspaceId])).rows[0]?.id||'';
  const offices=await listOwnerWorkspaces(ownerId);
  return {workspace:{id:w.id,name:w.name,version:w.version,officeDesign:w.settings.officeDesign==='studio'?'studio':'classic'},offices,archivedOffices:await listArchivedOwnerWorkspaces(ownerId),settings:safeSettings(w.settings),agents,tasks,memories:rows.memories.filter((r:any)=>r.active).map(serialize),messages:rows.messages.map(serialize),approvals:rows.approvals.map((r:any)=>({...serialize(r),params:r.params,status:r.state,state:r.state,taskVersion:r.task_version,expiresAt:r.expires_at,tool:'memory.publish'})),artifacts:rows.artifacts.map(serialize),notifications:rows.notifications.map((r:any)=>({...serialize(r),kind:r.kind,readAt:r.read_at,read:!!r.read_at})),events:rows.audit_events.map((r:any)=>({...serialize(r),type:r.type})),usage:rows.usage_entries.map((r:any)=>({...serialize(r),state:r.state,reservedTokens:r.reserved_tokens,inputTokens:r.input_tokens,outputTokens:r.output_tokens,tokens:r.input_tokens+r.output_tokens,totalTokens:r.input_tokens+r.output_tokens,costMicrousd:r.cost_microusd})),attachments:rows.attachments.map(serialize),projects:rows.projects.map(serialize),syncedAt:now()};
}
async function updateTask(db:Queryable,row:any,status:string,patch:any={}){
  assert(status===row.status||transitions[row.status]?.includes(status),'INVALID_TRANSITION',`Недопустимый переход задачи: ${row.status} → ${status}.`);
  const data={...row.data,...patch,updatedAt:now()};await db.query('UPDATE tasks SET status=$1,data=$2,version=version+1,updated_at=now(),claimed=CASE WHEN $3 THEN false ELSE claimed END WHERE id=$4',[status,json(data),!['running','pause_requested','cancel_requested'].includes(status),row.id]);
  await audit(db,row.workspace_id,'task.status',{from:row.status,to:status},row.id);return {...serialize(row),...data,status,version:row.version+1};
}
async function persistArtifact(db:Queryable,task:any,resultText:string,usage?:any){
  const existing=(await db.query('SELECT * FROM artifacts WHERE task_id=$1 ORDER BY version DESC LIMIT 1',[task.id])).rows[0];if(existing&&existing.data.revision===(task.data.revision||0))return serialize(existing);
  const artifactId=id(),artifactVersion=existing?existing.version+1:1;
  const data={title:task.data.title,text:text(resultText,150000),format:'markdown',filename:`orvo-result-v${artifactVersion}.md`,accepted:false,author:task.agent_id,version:artifactVersion,revision:task.data.revision||0,test:process.env.ORVO_TEST_MODE==='1',usage:usage||null};
  await db.query('INSERT INTO artifacts(id,workspace_id,task_id,agent_id,version,data) VALUES($1,$2,$3,$4,$5,$6)',[artifactId,task.workspace_id,task.id,task.agent_id,artifactVersion,json(data)]);await updateTask(db,task,'ready_for_review',{latestArtifactId:artifactId,pendingResult:null,error:null});await notify(db,task.workspace_id,task.id,'result','Результат готов к просмотру');await audit(db,task.workspace_id,'artifact.saved',{artifactId,version:artifactVersion},task.id);return{id:artifactId,...data};
}
async function saveMemory(db:Queryable,workspaceId:string,p:any,source='owner'){
  const scope=z.enum(['workspace','project','agent']).parse(p.scope||'agent');const value=text(p.text,12000);
  if(scope==='agent'){assert(p.agentId,'INVALID_SCOPE','Выберите агента.',400);await owned(db,'agents',workspaceId,p.agentId);}
  if(scope==='project'){assert(p.projectId,'INVALID_SCOPE','Выберите проект.',400);await owned(db,'projects',workspaceId,p.projectId);}
  const record={text:value,type:z.enum(['fact','preference','rule']).parse(p.type||'rule'),source,author:'owner',scope,agentId:scope==='agent'?p.agentId:null,projectId:scope==='workspace'?null:p.projectId||null,active:true};
  if(p.projectId)await owned(db,'projects',workspaceId,p.projectId);
  let memoryId=p.id;if(memoryId){const row=await owned(db,'memories',workspaceId,memoryId);version(row,p.version);await db.query('UPDATE memories SET data=$1,scope=$2,agent_id=$3,project_id=$4,active=true,version=version+1 WHERE id=$5',[json(record),scope,record.agentId,record.projectId,memoryId]);}
  else{memoryId=id();await db.query('INSERT INTO memories(id,workspace_id,agent_id,project_id,scope,data) VALUES($1,$2,$3,$4,$5,$6)',[memoryId,workspaceId,record.agentId,record.projectId,scope,json(record)]);}
  await audit(db,workspaceId,'memory.saved',{memoryId,scope});return {id:memoryId};
}
function agentMatchScore(agent:any,description:string){const words=new Set(description.toLocaleLowerCase('ru-RU').match(/[\p{L}\p{N}]{3,}/gu)||[]);const profile=[agent.data.name,agent.data.role,agent.data.description].join(' ').toLocaleLowerCase('ru-RU');return [...words].reduce((score,word)=>score+(profile.includes(word)?1:0),0);}
export async function command(workspaceId:string,type:string,payload:any={},requestId:string,controlBindings:Record<string,any>={}){
  assert(typeof requestId==='string'&&requestId.length>=8&&requestId.length<=200,'REQUEST_ID_REQUIRED','Нужен уникальный идентификатор запроса.',400);
  assert(payload&&typeof payload==='object'&&!Array.isArray(payload),'INVALID_INPUT','Ожидается объект данных.',400);
  const fingerprint=createHash('sha256').update(json({type,payload})).digest('hex');
  return transaction(async db=>{
    const w=await workspaceLock(db,workspaceId);
    const previous=(await db.query('SELECT * FROM command_requests WHERE workspace_id=$1 AND request_id=$2',[workspaceId,requestId])).rows[0];
    if(previous){assert(previous.fingerprint===fingerprint,'IDEMPOTENCY_CONFLICT','Идентификатор запроса уже использован с другими параметрами.');return previous.result;}
    const recent=(await db.query("SELECT count(*)::int AS count FROM command_requests WHERE workspace_id=$1 AND created_at>now()-interval '1 minute'",[workspaceId])).rows[0];assert(recent.count<120,'RATE_LIMIT','Слишком много изменений. Повторите через минуту.',429);
    const result=await execute(db,w,type,payload);
    for(const [index,control] of (result.controls||[]).entries()){
      control.payload={...control.payload,...controlBindings[control.taskId]};
      control.id=`${requestId}:${index}`;
      await db.query('INSERT INTO runtime_controls(id,workspace_id,task_id,action,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[control.id,workspaceId,control.taskId,control.action,json(control.payload)]);
    }
    await db.query('INSERT INTO command_requests(workspace_id,request_id,type,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[workspaceId,requestId,type,fingerprint,json(result)]);return result;
  });
}
async function execute(db:Queryable,w:any,type:string,p:any):Promise<any>{
  const workspaceId=w.id;
  if(type==='agents.seed'){await insertTeam(db,workspaceId);await audit(db,workspaceId,type);return{ok:true};}
  if(type==='project.save'){
    const projectId=p.id||id(),data={name:text(p.name,200),description:p.description?text(p.description,12000):''};
    if(p.id){const row=await owned(db,'projects',workspaceId,p.id);version(row,p.version);await db.query('UPDATE projects SET data=$1,version=version+1 WHERE id=$2',[json(data),projectId]);}
    else await db.query('INSERT INTO projects(id,workspace_id,data) VALUES($1,$2,$3)',[projectId,workspaceId,json(data)]);
    return{id:projectId};
  }
  if(type==='settings.save'){
    const allowed=['name','timezone','model','provider','theme','maxTokens','maxTaskTokens','maxOutputTokens','maxSteps'];const settings={...w.settings};
    for(const key of allowed)if(p[key]!==undefined)settings[key]=p[key];
    if(settings.provider!==w.settings.provider||settings.model!==w.settings.model){settings.modelChecked=false;settings.checkedModels=[];settings.modelCheckAt=null;settings.modelCheckError=null;}
    if(p.provider!==undefined)z.enum(['gateway','openai','test']).parse(p.provider);
    assert(settings.provider!=='test'||process.env.ORVO_TEST_MODE==='1','TEST_MODE_DISABLED','Тестовый провайдер доступен только в отдельном тестовом режиме.',400);
    for(const key of ['name','timezone','model','theme'])if(settings[key])settings[key]=text(settings[key],200);
    for(const key of ['maxTokens','maxTaskTokens','maxOutputTokens','maxSteps'])settings[key]=z.number().int().min(1).max(key==='maxSteps'?10:1000000).parse(Number(settings[key]));
    assert(settings.maxOutputTokens<=settings.maxTaskTokens,'INVALID_LIMIT','Лимит ответа превышает бюджет задачи.',400);
    await db.query('UPDATE workspaces SET settings=$1,version=version+1 WHERE id=$2',[json(settings),workspaceId]);await audit(db,workspaceId,type,{fields:Object.keys(p).filter(k=>allowed.includes(k))});return{ok:true,settings:safeSettings(settings)};
  }
  if(type==='agents.create'){
    const agentId=id(),name=text(p.name,100),role=text(p.role||'Пользовательский агент',150),instructions=text(p.instructions||`Ты — ${role}. Работай с предоставленными материалами, честно описывай ограничения.`,20000);
    const data={id:agentId,workspaceId,roleKey:`custom-${agentId}`,name,role,description:text(p.description||role,1000),instructions,instructionVersion:1,color:p.color||'#b9a3ee',avatar:'custom',model:null,permissions:{'task.read':'allow','materials.read':'allow','artifact.save':'allow','memory.publish':'ask','shell':'deny','github':'deny','browser':'deny','email':'deny'},limits:{maxSteps:10,maxTokens:24000,maxOutputTokens:3000},archived:false};
    await db.query('INSERT INTO agents(id,workspace_id,role_key,data) VALUES($1,$2,$3,$4)',[agentId,workspaceId,data.roleKey,json(data)]);await db.query('INSERT INTO instruction_versions(id,workspace_id,agent_id,version,text) VALUES($1,$2,$3,1,$4)',[id(),workspaceId,agentId,instructions]);await audit(db,workspaceId,type,{agentId});return{id:agentId};
  }
  if(type==='agents.update'||type==='instructions.save'){
    const row=await owned(db,'agents',workspaceId,p.agentId||p.id);version(row,p.version);const data={...row.data};
    if(type==='instructions.save'||p.instructions!==undefined){data.instructions=text(p.text||p.instructions,20000);data.instructionVersion=(data.instructionVersion||1)+1;await db.query('INSERT INTO instruction_versions(id,workspace_id,agent_id,version,text) VALUES($1,$2,$3,$4,$5)',[id(),workspaceId,row.id,data.instructionVersion,data.instructions]);}
    if(type==='agents.update'){
      if(p.archived===false)await db.query('UPDATE agents SET archived=false WHERE id=$1',[row.id]);
      for(const key of ['name','role','description','avatar','color'])if(p[key]!==undefined)data[key]=text(p[key],key==='description'?1000:150);
      if(p.model!==undefined)data.model=p.model?text(p.model,200):null;
      if(p.permissions){const permissions={...data.permissions};for(const [key,val] of Object.entries(p.permissions)){assert(['materials.read','task.read','artifact.save','subtask.propose','input.request','memory.propose','memory.publish','shell','github','browser','email'].includes(key),'INVALID_TOOL','Неизвестный инструмент.',400);permissions[key]=z.enum(['allow','ask','deny']).parse(val);if(['shell','github','browser','email'].includes(key))assert(val==='deny','TOOL_UNAVAILABLE','Инструмент пока не подключён.',400);}data.permissions=permissions;}
      if(p.limits)data.limits={maxSteps:z.number().int().min(1).max(10).parse(p.limits.maxSteps??data.limits.maxSteps),maxTokens:z.number().int().min(100).max(100000).parse(p.limits.maxTokens??data.limits.maxTokens),maxOutputTokens:z.number().int().min(100).max(16000).parse(p.limits.maxOutputTokens??data.limits.maxOutputTokens)};
    }
    await db.query('UPDATE agents SET data=$1,version=version+1 WHERE id=$2',[json(data),row.id]);await audit(db,workspaceId,type,{agentId:row.id,instructionVersion:data.instructionVersion});return{id:row.id};
  }
  if(type==='agents.archive'){
    const row=await owned(db,'agents',workspaceId,p.id);const busy=await db.query('SELECT id FROM tasks WHERE workspace_id=$1 AND agent_id=$2 AND status=ANY($3::text[])',[workspaceId,row.id,active]);assert(!busy.rows.length,'AGENT_BUSY','У агента есть активные задачи. Дождитесь завершения или запросите их отмену.');await db.query('UPDATE agents SET archived=true,version=version+1 WHERE id=$1',[row.id]);await audit(db,workspaceId,type,{agentId:row.id});return{ok:true};
  }
  if(type==='memory.save')return saveMemory(db,workspaceId,p);
  if(type==='memory.delete'){const row=await owned(db,'memories',workspaceId,p.id);version(row,p.version);await db.query('UPDATE memories SET active=false,version=version+1 WHERE id=$1',[row.id]);await audit(db,workspaceId,type,{memoryId:row.id});return{ok:true};}
  if(type==='chat.send'){
    const agent=await owned(db,'agents',workspaceId,p.agentId);if(p.taskId){const task=await owned(db,'tasks',workspaceId,p.taskId);assert(task.agent_id===agent.id,'WRONG_AGENT','Сообщение относится к другому агенту.',400);}
    const messageId=id();const data={text:text(p.text,16000),role:'user',queuedForNextStep:!!p.taskId};await db.query('INSERT INTO messages(id,workspace_id,agent_id,task_id,data) VALUES($1,$2,$3,$4,$5)',[messageId,workspaceId,agent.id,p.taskId||null,json(data)]);await audit(db,workspaceId,type,{messageId,agentId:agent.id},p.taskId||null);return{id:messageId,persisted:true,executionStarted:false};
  }
  if(type==='task.create'){
    const title=text(p.title,200),description=text(p.description||p.title,30000);let agent;
    if(!p.agentId||p.agentId==='auto'){
      const candidates=(await db.query("SELECT a.*, (SELECT count(*)::int FROM tasks t WHERE t.workspace_id=a.workspace_id AND t.agent_id=a.id AND t.status=ANY($2::text[])) AS queue_size FROM agents a WHERE a.workspace_id=$1 AND a.archived=false ORDER BY a.created_at,a.id",[workspaceId,active])).rows;
      candidates.sort((a:any,b:any)=>Number(configured(w.settings,b.data))-Number(configured(w.settings,a.data))||agentMatchScore(b,title+' '+description)-agentMatchScore(a,title+' '+description)||a.queue_size-b.queue_size);
      agent=candidates[0];assert(agent,'NO_AGENT','Сначала создайте своего агента.',400);
    }else agent=await owned(db,'agents',workspaceId,p.agentId);
    assert(!agent.archived,'AGENT_ARCHIVED','Архивный агент не получает новые задачи.',400);
    const teamPlan=z.array(z.string()).max(3).parse(p.teamPlan||[]);for(const role of teamPlan){const found=await db.query('SELECT id FROM agents WHERE workspace_id=$1 AND (role_key=$2 OR id=$2) AND archived=false',[workspaceId,role]);assert(found.rows[0],'INVALID_TEAM','Роль команды не найдена.',400);}
    if(p.projectId)await owned(db,'projects',workspaceId,p.projectId);
    const attachmentIds=z.array(z.string().min(1).max(100)).max(3).parse(p.attachmentIds||[]);for(const attachmentId of attachmentIds){const attachment=await owned(db,'attachments',workspaceId,attachmentId);assert(attachment.data.status==='ready','ATTACHMENT_NOT_READY','Обязательное вложение ещё не готово.',400);}
    const taskId=id();const ready=configured(w.settings,agent.data);let scheduledAt=p.scheduledAt?new Date(p.scheduledAt).toISOString():null;
    const maxTokens=Math.min(z.number().int().positive().parse(Number(p.maxTokens||agent.data.limits.maxTokens)),agent.data.limits.maxTokens,w.settings.maxTaskTokens);
    const maxSteps=Math.min(z.number().int().positive().parse(Number(p.maxSteps||agent.data.limits.maxSteps)),10,w.settings.maxSteps);
    const status=p.draft?'draft':!ready?'waiting_for_input':scheduledAt&&new Date(scheduledAt).getTime()>Date.now()?'scheduled':'queued';
    const data={title,description,expectedOutput:p.expectedOutput?text(p.expectedOutput,3000):'',projectContext:p.projectContext?text(p.projectContext,12000):'',priority:z.enum(['low','normal','high']).parse(p.priority||'normal'),deadline:p.deadline?new Date(p.deadline).toISOString():null,teamPlan,projectId:p.projectId||null,materials:z.array(z.string().max(30000)).max(10).parse(p.materials||[]).map(v=>text(v,30000)),attachmentIds,scheduledAt,maxTokens,maxSteps,revision:0,proposeMemory:p.proposeMemory?text(p.proposeMemory,12000):null,testScenario:process.env.ORVO_TEST_MODE==='1'&&w.settings.provider==='test'?p.testScenario||null:null,inputRequested:!!(p.inputRequested||p.requiresInput),setupRequired:!ready,error:!ready?'Подключите модель и проверьте серверные credentials.':null,createdAt:now()};
    await db.query('INSERT INTO tasks(id,workspace_id,agent_id,status,data) VALUES($1,$2,$3,$4,$5)',[taskId,workspaceId,agent.id,status,json(data)]);await audit(db,workspaceId,type,{agentId:agent.id,status},taskId);return{id:taskId,status,setupRequired:!ready,dispatchTaskIds:ready&&!p.draft?[taskId]:[]};
  }
  if(type.startsWith('task.')){
    const row=await owned(db,'tasks',workspaceId,p.id||p.taskId);version(row,p.version);let next:string;
    if(type==='task.resume'&&row.status==='paused'&&row.data.pendingResult){const artifact=await persistArtifact(db,row,row.data.pendingResult);return{id:row.id,status:'ready_for_review',artifactId:artifact.id,controls:row.data.workflowRunId?[{taskId:row.id,action:'resume',payload:{}}]:[]};}
    if(type==='task.pause'){assert(['running','queued','scheduled','retry_scheduled'].includes(row.status),'INVALID_TRANSITION','Эту задачу сейчас нельзя поставить на паузу.');next=row.status==='running'?'pause_requested':'paused';}
    else if(type==='task.cancel'){assert(!terminal.includes(row.status),'INVALID_TRANSITION','Задача уже завершена.');next=['running','pause_requested'].includes(row.status)?'cancel_requested':'cancelled';await db.query("UPDATE approvals SET state='revoked',version=version+1 WHERE task_id=$1 AND state='pending'",[row.id]);}
    else if(type==='task.resume'||type==='task.retry'||type==='task.start'){
      assert((type==='task.start'?['draft','waiting_for_input']:type==='task.resume'?['paused','waiting_for_input','retry_scheduled']:['failed']).includes(row.status),'INVALID_TRANSITION','Продолжение сейчас недоступно.');const agent=await owned(db,'agents',workspaceId,row.agent_id);assert(configured(w.settings,agent.data),'MODEL_NOT_CONFIGURED','Подключите модель перед запуском.',400);assert(!agent.archived,'AGENT_ARCHIVED','Агент архивирован.',400);next='queued';
    }
    else if(type==='task.accept'){assert(row.status==='ready_for_review','INVALID_TRANSITION','Нет готового результата для принятия.');next='completed';const latest=(await db.query('SELECT * FROM artifacts WHERE task_id=$1 ORDER BY version DESC LIMIT 1',[row.id])).rows[0];assert(latest,'NO_RESULT','Результат не найден.');await db.query('UPDATE artifacts SET data=$1 WHERE id=$2',[json({...latest.data,accepted:true,acceptedAt:now()}),latest.id]);}
    else if(type==='task.revise'){assert(row.status==='ready_for_review','INVALID_TRANSITION','Правки доступны после готового результата.');assert((row.data.revision||0)<3,'REVISION_LIMIT','Достигнут лимит трёх циклов правок.');next='queued';p.comment=text(p.comment,8000);}
    else throw new DomainError('UNKNOWN_COMMAND','Неизвестная команда задачи.',400);
    const restart=type==='task.retry'||type==='task.revise'||type==='task.start'||(type==='task.resume'&&!row.data.workflowRunId);
    if(next==='queued')assert(!row.data.runtimeDispatchUncertainId||row.data.runtimeDispatchSentId===row.data.runtimeDispatchUncertainId,'RUNTIME_RECONCILIATION_REQUIRED','Исход отправки исполнителю неизвестен. Нужна ручная сверка журнала выполнения; повторный запуск временно запрещён.',409);
    const patch={...(type==='task.revise'?{revision:(row.data.revision||0)+1,revisionComment:p.comment}:{}),...(next==='queued'?{error:null,setupRequired:false,...(restart?{workflowRunId:null}:{})}:{}),...(p.comment&&type!=='task.revise'?{inputReply:text(p.comment,8000)}:{})};
    await updateTask(db,row,next,patch);return{id:row.id,status:next,dispatchTaskIds:next==='queued'&&restart?[row.id]:[],controls:!restart&&row.data.workflowRunId?[{taskId:row.id,action:type.split('.')[1],payload:{text:p.comment||'',runtimeId:row.data.workflowRunId}}]:[]};
  }
  if(type==='approval.decide'){
    const approval=await owned(db,'approvals',workspaceId,p.id);version(approval,p.version);assert(approval.state==='pending','APPROVAL_CONFLICT','Решение уже принято или отозвано.');assert(new Date(approval.expires_at).getTime()>Date.now(),'APPROVAL_EXPIRED','Срок подтверждения истёк.');const task=await owned(db,'tasks',workspaceId,approval.task_id);
    assert(task.status==='waiting_for_approval'&&task.version===approval.task_version,'STALE_APPROVAL','Задача изменилась. Требуется новое подтверждение.');const agent=await owned(db,'agents',workspaceId,approval.agent_id);assert(agent.data.permissions?.['memory.publish']!=='deny','TOOL_DENIED','Доступ к общей памяти отозван.');
    const decision=z.enum(['approve','reject']).parse(p.decision);if(decision==='approve'){assert(approval.params.tool==='memory.publish','TOOL_DENIED','Операция не поддерживается.');await saveMemory(db,workspaceId,{scope:'workspace',type:'rule',text:approval.params.text},'approval');}
    await db.query('UPDATE approvals SET state=$1,version=version+1 WHERE id=$2',[decision==='approve'?'approved':'rejected',approval.id]);await updateTask(db,task,'queued',{approvalDecision:decision});await audit(db,workspaceId,'approval.decided',{approvalId:approval.id,decision},task.id);return{ok:true,controls:[{taskId:task.id,action:decision,payload:{approvalId:approval.id}}]};
  }
  if(type==='notifications.read'){if(p.id)await db.query('UPDATE notifications SET read_at=now() WHERE workspace_id=$1 AND id=$2',[workspaceId,p.id]);else await db.query('UPDATE notifications SET read_at=now() WHERE workspace_id=$1 AND read_at IS NULL',[workspaceId]);return{ok:true};}
  throw new DomainError('UNKNOWN_COMMAND','Неизвестная команда.',400);
}

export async function getTask(taskId:string):Promise<Task>{const row=(await query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];assert(row,'NOT_FOUND','Задача не найдена.',404);const steps=(await query('SELECT * FROM task_steps WHERE task_id=$1 ORDER BY created_at',[taskId])).rows.map(serialize);return {...serialize(row),steps};}
export async function prepareTask(taskId:string,contextAgentId?:string){
  const task=await getTask(taskId);const w=(await query('SELECT * FROM workspaces WHERE id=$1',[task.workspaceId])).rows[0];const agentRow=(await query('SELECT * FROM agents WHERE id=$1 AND workspace_id=$2',[contextAgentId||task.agentId,task.workspaceId])).rows[0];assert(agentRow,'NOT_FOUND','Агент не найден в пространстве задачи.',404);const agent=serialize(agentRow);assert(agent.id===task.agentId||(task.teamPlan||[]).includes(agent.id)||(task.teamPlan||[]).includes(agent.roleKey),'CONTEXT_AGENT_DENIED','Агент не назначен этапу этой задачи.',403);
  const memories=(await query("SELECT * FROM memories WHERE workspace_id=$1 AND active=true AND (scope='workspace' OR (scope='agent' AND agent_id=$2 AND (project_id IS NULL OR project_id=$3)) OR (scope='project' AND project_id=$3)) ORDER BY created_at DESC LIMIT 30",[task.workspaceId,agent.id,task.projectId||null])).rows.map(serialize);
  const attachments=(await query('SELECT * FROM attachments WHERE workspace_id=$1 AND (task_id=$2 OR id=ANY($3::text[]))',[task.workspaceId,task.id,task.attachmentIds||[]])).rows.map(serialize);
  if(attachments.length||(task.materials||[]).length)assert(agent.permissions?.['materials.read']==='allow','TOOL_DENIED','Чтение материалов не разрешено этому агенту. Разрешите инструмент перед следующим шагом.',403);
  const agents=(await query('SELECT * FROM agents WHERE workspace_id=$1 AND archived=false',[task.workspaceId])).rows.map(serialize);
  const messages=(await query('SELECT * FROM messages WHERE workspace_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 10',[task.workspaceId,task.id])).rows.map(serialize).reverse();
  return{workspaceId:task.workspaceId,task,agent,settings:safeSettings(w.settings),memories,materials:[...(task.materials||[]),...attachments.filter((a:any)=>a.status==='ready').map((a:any)=>a.text||'')],agents,messages};
}
export async function setTaskStatus(taskId:string,status:TaskStatus,patch:any={}){
  z.enum(TASK_STATUSES).parse(status);return transaction(async db=>{const existing=(await db.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];assert(existing,'NOT_FOUND','Задача не найдена.',404);await workspaceLock(db,existing.workspace_id);const row=await owned(db,'tasks',existing.workspace_id,taskId);if(['cancel_requested','cancelled'].includes(row.status)&&status!=='cancelled')return serialize(row);if(row.status==='pause_requested'&&status==='running')return serialize(row);return updateTask(db,row,status,patch);});
}
export async function commitRuntimeId(taskId:string,runtimeId:string){return transaction(async db=>{const task=(await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];assert(task,'NOT_FOUND','Задача не найдена.',404);if(task.data.workflowRunId&&task.data.workflowRunId!==runtimeId)return false;await db.query('UPDATE tasks SET data=$1 WHERE id=$2',[json({...task.data,workflowRunId:runtimeId}),task.id]);await db.query('INSERT INTO task_runs(id,workspace_id,task_id,runtime_id,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(runtime_id) DO NOTHING',[id(),task.workspace_id,task.id,runtimeId,json({revision:task.data.revision||0})]);return true;});}
export async function recordTaskEvent(taskId:string,type:string,data:any={}){return transaction(async db=>{const t=(await db.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];assert(t,'NOT_FOUND','Задача не найдена.',404);await audit(db,t.workspace_id,type,data,taskId);if(type.startsWith('step.'))await db.query('INSERT INTO task_steps(id,workspace_id,task_id,data) VALUES($1,$2,$3,$4)',[id(),t.workspace_id,taskId,json({type,status:type==='step.completed'?'completed':type==='step.failed'?'failed':'running',title:data.role||`Этап ${Number(data.stage||0)+1}`,summary:type==='step.completed'?'Результат этапа сохранён':type,...data})]);});}
export async function saveResult(taskId:string,resultText:string,usage?:any){
  return transaction(async db=>{const preliminary=(await db.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];assert(preliminary,'NOT_FOUND','Задача не найдена.',404);await workspaceLock(db,preliminary.workspace_id);const task=await owned(db,'tasks',preliminary.workspace_id,taskId);if(['cancel_requested','cancelled'].includes(task.status)){await updateTask(db,task,'cancelled');return null;}const agent=await owned(db,'agents',task.workspace_id,task.agent_id);assert(agent.data.permissions?.['artifact.save']==='allow','TOOL_DENIED','Сохранение артефакта не разрешено агенту. Подтвердите право в настройках инструмента.',403);if(task.status==='pause_requested'){await updateTask(db,task,'paused',{pendingResult:text(resultText,150000)});return null;}assert(!terminal.includes(task.status),'INVALID_TRANSITION','Задача завершена.');
    return persistArtifact(db,task,resultText,usage);
  });
}
export async function failTask(taskId:string,error:any){const message=typeof error==='string'?error:typeof error?.message==='string'?error.message:'Не удалось завершить задачу.';return transaction(async db=>{const p=(await db.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];assert(p,'NOT_FOUND','Задача не найдена.',404);await workspaceLock(db,p.workspace_id);const t=await owned(db,'tasks',p.workspace_id,taskId);if(['cancel_requested','cancelled'].includes(t.status))return updateTask(db,t,'cancelled');const safe=secretPattern.test(message)?'Ошибка подключения. Проверьте серверную конфигурацию.':message.slice(0,1000);await updateTask(db,t,'failed',{error:safe});await notify(db,t.workspace_id,t.id,'error','Ошибка выполнения задачи');});}
export async function claimTask(taskId:string,ownerRunId?:string){return transaction(async db=>{
  const p=(await db.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];assert(p,'NOT_FOUND','Задача не найдена.',404);await workspaceLock(db,p.workspace_id);const t=await owned(db,'tasks',p.workspace_id,taskId);
  if(t.claimed)return !!ownerRunId&&t.data.claimedOwner===ownerRunId&&t.status==='running';
  if(!['queued','scheduled','retry_scheduled'].includes(t.status))return false;
  if(t.data.scheduledAt&&new Date(t.data.scheduledAt).getTime()>Date.now())return false;
  const count=await db.query('SELECT agent_id FROM tasks WHERE workspace_id=$1 AND claimed=true',[t.workspace_id]);if(count.rows.length>=2||count.rows.some((r:any)=>r.agent_id===t.agent_id))return false;
  const a=await owned(db,'agents',t.workspace_id,t.agent_id);assert(!a.archived,'AGENT_ARCHIVED','Агент архивирован.');await db.query("UPDATE tasks SET claimed=true,status='running',data=$2,version=version+1,updated_at=now() WHERE id=$1",[taskId,json({...t.data,claimedOwner:ownerRunId||null})]);await audit(db,t.workspace_id,'task.claimed',{},taskId);return true;
});}
export async function releaseTask(taskId:string,ownerRunId?:string){if(ownerRunId)await query("UPDATE tasks SET claimed=false WHERE id=$1 AND data->>'claimedOwner'=$2",[taskId,ownerRunId]);else await query('UPDATE tasks SET claimed=false WHERE id=$1',[taskId]);}
export async function reserveUsage(taskId:string,inputBudget:number,outputBudget:number,model:string,stepKey?:string,executingAgentId?:string){return transaction(async db=>{
  const p=(await db.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];assert(p,'NOT_FOUND','Задача не найдена.',404);const w=await workspaceLock(db,p.workspace_id);const t=await owned(db,'tasks',p.workspace_id,taskId);assert(t.status==='running','TASK_NOT_RUNNING','Новый вызов модели запрещён текущим состоянием задачи.');
  const reserved=z.number().int().min(1).parse(inputBudget+outputBudget);const entries=(await db.query('SELECT * FROM usage_entries WHERE workspace_id=$1',[t.workspace_id])).rows;
  if(stepKey){const previous=entries.find((r:any)=>r.task_id===taskId&&r.data.stepKey===stepKey);if(previous)return previous.id;}
  const agentId=executingAgentId||t.agent_id;const agent=await owned(db,'agents',t.workspace_id,agentId);assert(!agent.archived,'AGENT_ARCHIVED','Агент архивирован.');assert(agentId===t.agent_id||(t.data.teamPlan||[]).includes(agentId)||(t.data.teamPlan||[]).includes(agent.role_key),'CONTEXT_AGENT_DENIED','Агент не назначен задаче.',403);assert(configured(w.settings,agent.data)&&model===(agent.data.model||w.settings.model),'MODEL_NOT_CONFIGURED','Подключение выбранной модели не подтверждено.',400);assert(!entries.some((r:any)=>r.agent_id===agentId&&r.task_id!==taskId&&r.state==='reserved'),'AGENT_BUSY','Агент уже выполняет другое задание.');
  const amount=(r:any)=>['reserved','unknown'].includes(r.state)?r.reserved_tokens:r.input_tokens+r.output_tokens;
  const checkTokens=Number((await db.query('SELECT COALESCE(sum(reserved_tokens),0) AS tokens FROM model_checks WHERE workspace_id=$1',[t.workspace_id])).rows[0].tokens);
  const taskUsed=entries.filter((r:any)=>r.task_id===taskId).reduce((s:number,r:any)=>s+amount(r),0);const workspaceUsed=entries.reduce((s:number,r:any)=>s+amount(r),0)+checkTokens;const steps=entries.filter((r:any)=>r.task_id===taskId).length;
  assert(taskUsed+reserved<=t.data.maxTokens&&workspaceUsed+reserved<=w.settings.maxTokens&&steps<t.data.maxSteps,'QUOTA_EXCEEDED','Достигнут токенный лимит или лимит шагов. Новые вызовы остановлены.');
  const reservationId=id();await db.query("INSERT INTO usage_entries(id,workspace_id,task_id,agent_id,state,reserved_tokens,data) VALUES($1,$2,$3,$4,'reserved',$5,$6)",[reservationId,t.workspace_id,taskId,agentId,reserved,json({model,stepKey:stepKey||null,revision:t.data.revision||0,test:process.env.ORVO_TEST_MODE==='1'})]);await audit(db,t.workspace_id,'usage.reserved',{reservationId,reserved},taskId);if((taskUsed+reserved)/t.data.maxTokens>=0.8)await notify(db,t.workspace_id,taskId,'limit','Использовано более 80% бюджета задачи');return reservationId;
});}
export async function settleUsage(reservationId:string,usage:any={}){return transaction(async db=>{const row=(await db.query('SELECT * FROM usage_entries WHERE id=$1 FOR UPDATE',[reservationId])).rows[0];assert(row,'NOT_FOUND','Резерв не найден.',404);if(row.state!=='reserved')return;const inputTokens=z.number().int().min(0).parse(Number(usage.inputTokens||0)),outputTokens=z.number().int().min(0).parse(Number(usage.outputTokens||0));await db.query("UPDATE usage_entries SET state=$1,input_tokens=$2,output_tokens=$3,data=$4 WHERE id=$5",[usage.unknown?'unknown':'settled',inputTokens,outputTokens,json({...row.data,usageKnown:!usage.unknown}),reservationId]);});}
export async function createApproval(taskId:string,params:any){return transaction(async db=>{
  const p=(await db.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];assert(p,'NOT_FOUND','Задача не найдена.',404);await workspaceLock(db,p.workspace_id);const t=await owned(db,'tasks',p.workspace_id,taskId);const agent=await owned(db,'agents',t.workspace_id,t.agent_id);assert(agent.data.permissions?.['memory.publish']!=='deny','TOOL_DENIED','Публикация общей памяти запрещена.');
  const bound={tool:'memory.publish',scope:'workspace',text:text(params.text,12000),revision:t.data.revision||0,consequence:'Запись будет учитываться всеми агентами пространства.'};const previous=(await db.query('SELECT * FROM approvals WHERE task_id=$1 ORDER BY created_at DESC',[taskId])).rows.find((a:any)=>a.params.tool===bound.tool&&a.params.text===bound.text&&a.params.revision===bound.revision);if(previous)return{id:previous.id,params:previous.params,version:previous.version,expiresAt:previous.expires_at,state:previous.state};assert(t.status==='running','INVALID_TRANSITION','Подтверждение сейчас недоступно.');await updateTask(db,t,'waiting_for_approval');const approvalId=id(),expiresAt=new Date(Date.now()+24*60*60*1000).toISOString();await db.query('INSERT INTO approvals(id,workspace_id,task_id,agent_id,params,task_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[approvalId,t.workspace_id,taskId,t.agent_id,json(bound),t.version+1,expiresAt]);await notify(db,t.workspace_id,taskId,'approval','Требуется подтверждение записи в общую память');return{id:approvalId,params:bound,version:1,expiresAt,state:'pending'};
});}
export const requestApproval=createApproval;
