import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

// Owner-only, local, non-billable HTTP smoke. No profile, settings or seed commands.
const origin='http://127.0.0.1:3000';
const reportPath=path.resolve('.orvo/office-smoke-report.json');
const mainTaskId='2d041ea0-9b9d-4913-b365-07a76d89a100';
const runId=randomUUID().slice(0,8);
const title=(name:string)=>`[АВТОТЕСТ] ${runId} ${name}`;
const active=new Set(['queued','scheduled','running','pause_requested','paused','waiting_for_input','waiting_for_approval','retry_scheduled','cancel_requested']);
type Item={name:string;status:'PASS'|'FAIL'|'SKIP';detail?:string;taskId?:string};
const report:{testData:true;runId:string;startedAt:string;finishedAt?:string;mode?:string;agentId?:string;baseline?:any;final?:any;results:Item[];createdTaskIds:string[]}={testData:true,runId,startedAt:new Date().toISOString(),results:[],createdTaskIds:[]};
let cookie='';
let agentId='';
let baselinePixel='';
let baselineMain='';
let baselineCounts:any;

async function save(){await mkdir(path.dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
async function getJson(url:string,withCookie=false){
  const response=await fetch(`${origin}${url}`,{headers:withCookie?{cookie}:{},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
async function state():Promise<any>{return getJson('/api/state',true);}
async function command(type:string,payload:Record<string,unknown>={},requestId=randomUUID()):Promise<any>{
  for(let attempt=0;attempt<15;attempt++){
    const response=await fetch(`${origin}/api/command`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({type,payload,requestId}),signal:AbortSignal.timeout(60000)});
    const data=await response.json();
    if(data.error?.code==='RUNTIME_INPUT_NOT_READY'){await delay(500);continue;}
    if(!response.ok)throw new Error(`${type}: ${data.error?.code||response.status}`);
    return data.result;
  }
  throw new Error(`${type}: runtime input did not become ready`);
}
async function expectCommandFailure(type:string,payload:Record<string,unknown>,expectedCode:string){
  const response=await fetch(`${origin}/api/command`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({type,payload,requestId:randomUUID()}),signal:AbortSignal.timeout(30000)});
  const data=await response.json();
  if(response.status!==409||data.error?.code!==expectedCode)throw new Error(`${type}: expected HTTP 409 ${expectedCode}, received ${response.status} ${data.error?.code||''}`);
  return data.error.code as string;
}
async function create(name:string,payload:Record<string,unknown>={}){
  const result=await command('task.create',{title:title(name),description:`Управляемая проверка Orvo ${runId}. Верни краткий результат с пометкой ТЕСТОВЫЕ ДАННЫЕ.`,agentId,...payload});
  report.createdTaskIds.push(result.id);await save();return result;
}
async function waitTask(id:string,statuses:string[],timeout=120000){
  const until=Date.now()+timeout;
  while(Date.now()<until){
    const snapshot=await state(),task=snapshot.tasks.find((item:any)=>item.id===id);
    if(task&&statuses.includes(task.status))return{task,snapshot};
    if(task?.status==='failed')throw new Error(`task ${id}: failed (${String(task.error||'unknown').slice(0,120)})`);
    await delay(700);
  }
  throw new Error(`task ${id}: timeout awaiting ${statuses.join('/')}`);
}
async function accept(id:string){await command('task.accept',{id});const {task}=await waitTask(id,['completed'],15000);if(task.status!=='completed')throw new Error('accept did not complete task');}
function counts(snapshot:any){return{agents:snapshot.agents.length,tasks:snapshot.tasks.length,artifacts:snapshot.artifacts.length,memories:snapshot.memories.length,approvals:snapshot.approvals.length};}
function pixelConfig(agent:any){if(!agent)return null;const {id,name,role,description,avatar,instructions,instructionVersion,model,permissions,limits,archived,version}=agent;return{id,name,role,description,avatar,instructions,instructionVersion,model,permissions,limits,archived,version};}
async function check(name:string,fn:()=>Promise<{taskId?:string;detail?:string}>){
  try{const value=await fn();report.results.push({name,status:'PASS',...value});console.log(`PASS ${name}`);}
  catch(error){const detail=(error as Error).message.slice(0,220);report.results.push({name,status:'FAIL',detail});console.error(`FAIL ${name}: ${detail}`);}
  await save();
}
async function cleanup(){
  for(const id of report.createdTaskIds){
    try{const snapshot=await state(),task=snapshot.tasks.find((item:any)=>item.id===id);if(task&&active.has(task.status))await command('task.cancel',{id});}
    catch(error){report.results.push({name:'cleanup '+id,status:'FAIL',detail:(error as Error).message.slice(0,180)});}
  }
  try{
    const memoryText=`ТЕСТОВЫЕ ДАННЫЕ: подтверждённое правило [АВТОТЕСТ] ${runId}`;
    const records=(await state()).memories.filter((item:any)=>item.text===memoryText);
    for(const record of records)await command('memory.delete',{id:record.id});
  }catch(error){report.results.push({name:'cleanup memory',status:'FAIL',detail:(error as Error).message.slice(0,180)});}
}

try{
  const health=await getJson('/api/health');
  if(health.ok!==true||health.testMode!==true)throw new Error('Preflight: server is not in test mode; no task was created');
  const access=JSON.parse(await readFile('.orvo/test-access.json','utf8')) as {email:string;password:string};
  const login=await fetch(`${origin}/api/auth/sign-in/email`,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(access),signal:AbortSignal.timeout(30000)});
  if(!login.ok)throw new Error(`Preflight: login HTTP ${login.status}`);
  cookie=login.headers.getSetCookie().map(entry=>entry.split(';')[0]).join('; ');
  if(!cookie)throw new Error('Preflight: session cookie absent');
  const initial=await state();
  if(initial.settings.provider!=='test'||initial.settings.testMode!==true)throw new Error('Preflight: provider is not test; no task was created');
  report.mode='test';baselineCounts=counts(initial);report.baseline=baselineCounts;
  const pixel=initial.agents.find((item:any)=>item.name==='Пиксель');
  const main=initial.tasks.find((item:any)=>item.id===mainTaskId);
  if(!pixel||!main)throw new Error('Preflight: Pixel or protected main task missing; no task was created');
  if(['running','queued','scheduled','retry_scheduled','pause_requested','cancel_requested'].includes(main.status))throw new Error('Preflight: protected main task is executing or queued; no task was created');
  baselinePixel=JSON.stringify(pixelConfig(pixel));baselineMain=JSON.stringify(main);
  const modelReady=(agent:any)=>{const model=agent.model||initial.settings.model;return !agent.archived&&model&&initial.settings.checkedModels?.includes(model)&&initial.settings.credentialsConfigured&&agent.permissions?.['artifact.save']==='allow';};
  const candidate=initial.agents.find((item:any)=>item.id!==pixel.id&&modelReady(item))||initial.agents.find(modelReady);
  if(!candidate)throw new Error('Preflight: no configured test agent with artifact.save; no task was created');
  if(process.argv.includes('--finish-previous')){
    const previous=JSON.parse(await readFile(reportPath,'utf8')) as {runId:string;createdTaskIds:string[]};
    for(const id of previous.createdTaskIds){const task=initial.tasks.find((item:any)=>item.id===id);
      if(task?.status==='ready_for_review'&&task.title.startsWith(`[АВТОТЕСТ] ${previous.runId} `)){await accept(id);console.log(`PASS accepted previous test task ${id}`);}
    }
    process.exit(0);
  }
  agentId=candidate.id;report.agentId=agentId;await save();
  console.log(`Preflight PASS: test provider, ${initial.agents.length} agents, protected task ${main.status}, agent selected`);
  if(process.argv.includes('--preflight')){report.results.push({name:'preflight',status:'PASS'});await save();process.exit(0);}

  await check('task → artifact → accept',async()=>{
    const created=await create('Результат');const done=await waitTask(created.id,['ready_for_review']);
    const artifacts=done.snapshot.artifacts.filter((item:any)=>item.taskId===created.id);
    if(artifacts.length!==1||!String(artifacts[0].text).includes('ТЕСТОВЫЕ ДАННЫЕ'))throw new Error('expected one fixture artifact');
    await accept(created.id);return{taskId:created.id,detail:'one fixture artifact; completed'};
  });
  await check('idempotent task creation',async()=>{
    const requestId=randomUUID(),payload={title:title('Идемпотентность'),description:'ТЕСТОВЫЕ ДАННЫЕ: проверка повторного создания.',agentId,draft:true};
    const first=await command('task.create',payload,requestId);report.createdTaskIds.push(first.id);await save();
    const second=await command('task.create',payload,requestId);
    const snapshot=await state();
    if(first.id!==second.id||snapshot.tasks.filter((item:any)=>item.id===first.id).length!==1)throw new Error('duplicate task or changed ID');
    await command('task.cancel',{id:first.id});return{taskId:first.id,detail:'same ID, one record'};
  });
  await check('waiting_for_input → resume',async()=>{
    const created=await create('Уточнение',{inputRequested:true});
    const waiting=await waitTask(created.id,['waiting_for_input']);
    await command('task.resume',{id:created.id,comment:'ТЕСТОВЫЕ ДАННЫЕ: подтверждаю короткий результат.'});
    const done=await waitTask(created.id,['ready_for_review']);
    if(!waiting.task.workflowRunId||done.task.workflowRunId!==waiting.task.workflowRunId)throw new Error('runtime ID changed');
    await accept(created.id);return{taskId:created.id,detail:'same runtime; completed'};
  });
  await check('pause → resume',async()=>{
    const created=await create('Пауза',{scheduledAt:new Date(Date.now()+5000).toISOString()});
    await command('task.pause',{id:created.id});
    const paused=await waitTask(created.id,['paused']);
    await delay(5500);
    await command('task.resume',{id:created.id});
    const done=await waitTask(created.id,['ready_for_review']);
    if(paused.task.workflowRunId&&done.task.workflowRunId!==paused.task.workflowRunId)throw new Error('runtime ID changed');
    await accept(created.id);return{taskId:created.id,detail:'completed after pause'};
  });
  await check('cancel before execution',async()=>{
    const created=await create('Отмена',{scheduledAt:new Date(Date.now()+60000).toISOString()});
    await command('task.cancel',{id:created.id});
    const done=await waitTask(created.id,['cancelled']);
    if(done.snapshot.usage.some((item:any)=>item.taskId===created.id))throw new Error('cancelled task consumed model tokens');
    return{taskId:created.id,detail:'cancelled; zero model usage'};
  });
  await check('429 fixture → bounded retry',async()=>{
    const created=await create('Повтор 429',{testScenario:'retry_once'});
    const done=await waitTask(created.id,['ready_for_review']);
    const usage=done.snapshot.usage.filter((item:any)=>item.taskId===created.id);
    if(usage.length!==2)throw new Error(`expected two reservations, got ${usage.length}`);
    await accept(created.id);return{taskId:created.id,detail:'two attempts; completed'};
  });
  await check('memory approval is one-time',async()=>{
    const memoryText=`ТЕСТОВЫЕ ДАННЫЕ: подтверждённое правило [АВТОТЕСТ] ${runId}`;
    const created=await create('Согласование памяти',{proposeMemory:memoryText});
    const waiting=await waitTask(created.id,['waiting_for_approval']);
    const approval=waiting.snapshot.approvals.find((item:any)=>item.taskId===created.id&&item.state==='pending');
    if(!approval)throw new Error('pending approval absent');
    const before=waiting.snapshot.memories.filter((item:any)=>item.text===memoryText).length;
    const decisionRequestId=randomUUID();
    await command('approval.decide',{id:approval.id,version:approval.version,decision:'approve'},decisionRequestId);
    await command('approval.decide',{id:approval.id,version:approval.version,decision:'approve'},decisionRequestId);
    const done=await waitTask(created.id,['ready_for_review']);
    const records=done.snapshot.memories.filter((item:any)=>item.text===memoryText);
    const after=records.length;
    if(before!==0||after!==1)throw new Error(`memory count ${before}→${after}, expected 0→1`);
    const repeatedCode=await expectCommandFailure('approval.decide',{id:approval.id,decision:'approve'},'RUNTIME_INPUT_NOT_READY');
    if((await state()).memories.filter((item:any)=>item.text===memoryText).length!==1)throw new Error('repeated approval changed memory');
    await accept(created.id);
    await command('memory.delete',{id:records[0].id});
    if((await state()).memories.some((item:any)=>item.text===memoryText))throw new Error('test memory remained active');
    return{taskId:created.id,detail:`one approval; same request cached; new request HTTP 409 ${repeatedCode} (misleading message); test memory retired`};
  });
}catch(error){const detail=(error as Error).message.slice(0,220);report.results.push({name:'preflight or run',status:'FAIL',detail});console.error(`FAIL ${detail}`);}
finally{
  if(cookie){await cleanup();try{
    const final=await state();report.final={...counts(final),createdTasks:report.createdTaskIds.map(id=>({id,status:final.tasks.find((item:any)=>item.id===id)?.status||'missing'})),activeCreatedTasks:report.createdTaskIds.filter(id=>active.has(final.tasks.find((item:any)=>item.id===id)?.status))};
    const pixel=final.agents.find((item:any)=>item.name==='Пиксель');const main=final.tasks.find((item:any)=>item.id===mainTaskId);
    const preserved=JSON.stringify(pixelConfig(pixel))===baselinePixel&&JSON.stringify(main)===baselineMain;
    if(baselinePixel&&baselineMain)report.results.push({name:'protected Pixel profile and main task unchanged',status:preserved?'PASS':'FAIL'});
    if(report.final.activeCreatedTasks.length)report.results.push({name:'no active test tasks left',status:'FAIL',detail:report.final.activeCreatedTasks.join(',')});
    else if(report.createdTaskIds.length)report.results.push({name:'no active test tasks left',status:'PASS'});
  }catch(error){report.results.push({name:'final state',status:'FAIL',detail:(error as Error).message.slice(0,180)});}}
  report.finishedAt=new Date().toISOString();await save();
  console.log(`REPORT ${reportPath} PASS=${report.results.filter(item=>item.status==='PASS').length} FAIL=${report.results.filter(item=>item.status==='FAIL').length}`);
  if(report.results.some(item=>item.status==='FAIL'))process.exitCode=1;
}
