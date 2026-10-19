import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

// Owner authorized up to USD 1 for this run. Fixed inexpensive model, small
// per-task token caps, at most three generated tasks plus one connection check.
const origin='http://127.0.0.1:3000';
const reportPath='.orvo/live-smoke-report.json';
const mode=process.argv[2];
const mainId='2d041ea0-9b9d-4913-b365-07a76d89a100';
const model='gpt-6-luna';
const access=JSON.parse(await readFile('.orvo/test-access.json','utf8'));
const login=await fetch(`${origin}/api/auth/sign-in/email`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(access)});
assert.equal(login.status,200,'owner login');
const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
const headers={cookie,origin,'content-type':'application/json'};
async function state(){const response=await fetch(`${origin}/api/state`,{headers:{cookie},signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);return response.json();}
async function command(type:string,payload:any={},requestId=randomUUID()):Promise<any>{
  for(let attempt=0;attempt<12;attempt++){
    const response=await fetch(`${origin}/api/command`,{method:'POST',headers,body:JSON.stringify({type,payload,requestId}),signal:AbortSignal.timeout(90000)});
    const data=await response.json();
    if(data.error?.code==='RUNTIME_INPUT_NOT_READY'){await delay(500);continue;}
    assert.equal(response.ok,true,`${type}: ${data.error?.code||response.status}`);
    return data.result;
  }
  throw new Error('Runtime input did not become available');
}
let report:any=mode==='configure'?{at:new Date().toISOString(),model,budgetUsd:1,checks:[],taskIds:[],runId:randomUUID().slice(0,8)}:JSON.parse(await readFile(reportPath,'utf8'));
const save=()=>writeFile(reportPath,JSON.stringify(report,null,2));
async function waitTask(id:string,statuses:string[]){
  for(let attempt=0;attempt<180;attempt++){
    const snapshot=await state(),task=snapshot.tasks.find((item:any)=>item.id===id);
    if(statuses.includes(task?.status))return{task,snapshot};
    if(task?.status==='failed')throw new Error('Live task failed; inspect the saved task journal');
    await delay(700);
  }
  throw new Error('Live task timed out');
}
async function create(name:string,extra:any={}){
  const snapshot=await state();
  assert.equal(snapshot.settings.provider,'openai');assert.equal(snapshot.settings.model,model);
  const agent=snapshot.agents.find((item:any)=>item.id===report.agentId&&!item.archived);
  assert.ok(agent,'configured active agent');assert.equal(agent.model||snapshot.settings.model,model,'agent override must not change the priced model');
  assert.equal(report.taskIds.length<3,true,'live run has at most three tasks');
  const result=await command('task.create',{title:`[ЖИВОЙ ТЕСТ] ${report.runId} ${name}`,description:'Предложи дизайн лендинга студии керамики. Аудитория — начинающие. Нужны: 5 секций, палитра с HEX, 2 шрифта, мобильная версия и состояния кнопки. Ответ на русском, до 400 слов. Только текстовая концепция, без внешних действий.',expectedOutput:'Конкретная концепция дизайна, цвета HEX, типографика и адаптив.',agentId:report.agentId,maxTokens:10000,maxSteps:1,...extra});
  report.taskIds.push(result.id);await save();return result.id;
}
async function verifyResult(id:string){
  const {snapshot,task}=await waitTask(id,['ready_for_review']);
  const artifact=snapshot.artifacts.find((item:any)=>item.taskId===id);
  assert.ok(artifact?.text?.length>100);assert.doesNotMatch(artifact.text,/ТЕСТОВЫЕ ДАННЫЕ|Детерминированный результат/);
  assert.match(artifact.text,/#[0-9a-f]{6}/i);
  const usage=snapshot.usage.filter((item:any)=>item.taskId===id);
  assert.ok(usage.some((item:any)=>item.state==='settled'&&(item.inputTokens+item.outputTokens)>0));
  report.results??=[];report.results.push({taskId:id,status:task.status,artifactId:artifact.id,text:artifact.text,usage});await save();
  return task;
}
try{
 if(mode==='configure'){
   const snapshot=await state();
   assert.equal(snapshot.tasks.some((task:any)=>['running','queued','scheduled','retry_scheduled','pause_requested','cancel_requested'].includes(task.status)),false,'wait for existing work');
   const agent=snapshot.agents.find((item:any)=>item.name==='Пиксель'&&!item.archived);
   assert.ok(agent);assert.ok(!agent.model||agent.model===model,'preserve existing override; do not run a different model');report.agentId=agent.id;report.mainBefore=snapshot.tasks.find((item:any)=>item.id===mainId);report.settingsBefore={provider:snapshot.settings.provider,model:snapshot.settings.model};
   report.conservativeTokenCapUsd=(3*10000+512)*0.5/1_000_000;assert.ok(report.conservativeTokenCapUsd<report.budgetUsd);
   await save();
   await command('settings.save',{provider:'openai',model});
   report.connectionCheck=await command('settings.checkModel');assert.equal(report.connectionCheck.ok,true);report.checks.push('OpenAI connection check');
 }else if(mode==='create-design'){
   report.designId=await create('Дизайн лендинга');console.log('Live design task:',report.designId);
 }else if(mode==='finish-design'){
   await verifyResult(report.designId);report.checks.push('real task → design artifact, HEX, usage');
 }else if(mode==='input'){
   const id=await create('Уточнение',{inputRequested:true});
   const before=await waitTask(id,['waiting_for_input']);
   assert.equal(before.snapshot.usage.some((item:any)=>item.taskId===id),false);
   await command('task.resume',{id,comment:'Палитра терракотовая и кремовая, стиль спокойный, основная кнопка — Записаться.'});
   const done=await verifyResult(id);assert.equal(done.workflowRunId,before.task.workflowRunId);
   report.checks.push('waiting for input consumes no model call; resume same runtime');
 }else if(mode==='pause'){
   const id=await create('Пауза',{scheduledAt:new Date(Date.now()+5000).toISOString()});
   await command('task.pause',{id});await waitTask(id,['paused']);await delay(5500);
   assert.equal((await state()).usage.some((item:any)=>item.taskId===id),false);
   await command('task.resume',{id});await verifyResult(id);report.checks.push('pause before generation, resume → real result');
 }else throw new Error('Unknown live smoke mode');
 const final=await state();assert.deepEqual(final.tasks.find((item:any)=>item.id===mainId),report.mainBefore,'protected main brief');
 report.mainPreserved=true;
 report.tokenUsage=(report.results||[]).flatMap((item:any)=>item.usage).reduce((sum:any,item:any)=>({input:sum.input+(item.inputTokens||0),output:sum.output+(item.outputTokens||0)}),{input:0,output:0});
 // Standard short-context rates, checked 2026-10-19; upper bound ignores cached discount.
 const check=report.connectionCheck?.usage||{};
 report.estimatedUsd=((report.tokenUsage.input+(check.inputTokens||0))*0.1+(report.tokenUsage.output+(check.outputTokens||0))*0.5)/1_000_000;
 report.estimateSource='https://developers.openai.com/api/docs/pricing';
 assert.ok(report.estimatedUsd<report.budgetUsd);
 await save();console.log('PASS',mode,'checks:',report.checks.length,'estimated USD:',report.estimatedUsd.toFixed(6));
}catch(error){report.failure={mode,message:(error as Error).message};await save();console.error('FAIL',mode,(error as Error).message);process.exitCode=1;}
