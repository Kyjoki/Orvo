import { getSnapshot, recordModelCheck } from './domain';
import { DomainError } from '../shared/types';
import { transaction, query } from './db';
import { generateOpenAI } from './openai';
export async function checkModel(workspaceId:string,p:any,requestId:string){
  const snapshot=await getSnapshot(workspaceId), settings=snapshot.settings;
  const agent=p.agentId?snapshot.agents.find(a=>a.id===p.agentId):null;
  const model=agent?.model||settings.model;
  if(!model)throw new DomainError('MODEL_NOT_CONFIGURED','Укажите идентификатор модели.');
  const previous=await transaction(async db=>{
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);
    const old=(await db.query('SELECT * FROM model_checks WHERE workspace_id=$1 AND request_id=$2',[workspaceId,requestId])).rows[0];if(old)return old;
    const recent=(await db.query("SELECT count(*)::int AS count FROM model_checks WHERE workspace_id=$1 AND created_at>now()-interval '1 hour'",[workspaceId])).rows[0];
    if(recent.count>=5)throw new DomainError('CHECK_RATE_LIMIT','Разрешено до пяти проверок модели в час.',429);
    const used=(await db.query("SELECT COALESCE(sum(CASE WHEN state IN ('reserved','unknown') THEN reserved_tokens ELSE input_tokens+output_tokens END),0)::int AS tokens FROM usage_entries WHERE workspace_id=$1",[workspaceId])).rows[0].tokens;
    const checks=(await db.query('SELECT COALESCE(sum(reserved_tokens),0)::int AS tokens FROM model_checks WHERE workspace_id=$1',[workspaceId])).rows[0].tokens;
    const reserve=settings.provider==='test'?0:512;
    if(Number(used)+Number(checks)+reserve>settings.maxTokens)throw new DomainError('QUOTA_EXCEEDED','Общий токенный лимит не позволяет проверочный запрос.');
    await db.query('INSERT INTO model_checks(workspace_id,request_id,model,reserved_tokens) VALUES($1,$2,$3,$4)',[workspaceId,requestId,model,reserve]);return null;
  });
  if(previous){
    if(previous.model!==model)throw new DomainError('IDEMPOTENCY_CONFLICT','Этот запрос проверки относится к другой модели.');
    if(previous.state==='reserved')throw new DomainError('CHECK_PENDING','Проверка уже начата. Исход ещё не подтверждён; повторный платный запрос не отправлен.',409);
    if(previous.result?.error)throw new DomainError(previous.result.error.code,previous.result.error.message);
    return previous.result;
  }
  async function finish(result:any,usage?:any){await query("UPDATE model_checks SET state='completed',result=$1,input_tokens=$2,output_tokens=$3 WHERE workspace_id=$4 AND request_id=$5",[JSON.stringify(result),usage?.prompt_tokens||0,usage?.completion_tokens||0,workspaceId,requestId]);return result;}
  try {
    if(settings.provider==='test'){
      if(process.env.ORVO_TEST_MODE!=='1')throw new DomainError('TEST_MODE_DISABLED','Тестовый режим не включён.');
      await recordModelCheck(workspaceId,{ok:true,model});return finish({ok:true,test:true,message:'Подключён управляемый тестовый провайдер. Это не облачная модель.'});
    }
    if(settings.provider==='openai'){
      const key=process.env.OPENAI_API_KEY;
      if(!key)throw new DomainError('CREDENTIALS_MISSING','На сервере отсутствует OPENAI_API_KEY.',503);
      const catalog=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(15000)});
      if(!catalog.ok)throw new DomainError(catalog.status===401||catalog.status===403?'CREDENTIALS_REJECTED':'CATALOG_UNAVAILABLE','Не удалось подтвердить доступ к каталогу OpenAI.',502);
      const models=await catalog.json();
      if(!models.data?.some((entry:any)=>entry.id===model))throw new DomainError('MODEL_UNAVAILABLE','Модель отсутствует в доступном каталоге OpenAI.');
      const result=await generateOpenAI({model,system:'Ответь ровно OK.',prompt:'Проверка соединения.',maxOutputTokens:256});
      await recordModelCheck(workspaceId,{ok:true,model});
      return finish({ok:true,test:false,message:'OpenAI API ответил. Проверка расходует токены.',usage:result.usage},{prompt_tokens:result.usage.inputTokens,completion_tokens:result.usage.outputTokens});
    }
    const key=process.env.AI_GATEWAY_API_KEY;
    if(!key)throw new DomainError('CREDENTIALS_MISSING','На сервере отсутствует AI_GATEWAY_API_KEY.',503);
    const modelsResponse=await fetch('https://ai-gateway.vercel.sh/v1/models',{signal:AbortSignal.timeout(15000)});
    if(!modelsResponse.ok)throw new DomainError('CATALOG_UNAVAILABLE','Не удалось проверить каталог AI Gateway.',503);
    const models=await modelsResponse.json();
    if(!models.data?.some((m:any)=>m.id===model&&m.type==='language'))throw new DomainError('MODEL_UNAVAILABLE','Такого текстового идентификатора нет в актуальном каталоге Gateway.');
    const response=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model,messages:[{role:'user',content:'Reply OK.'}],max_tokens:8}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new DomainError(response.status===401||response.status===403?'CREDENTIALS_REJECTED':'MODEL_CHECK_FAILED',response.status===401||response.status===403?'Gateway отклонил credentials. Проверьте серверное подключение.':'Проверочный запрос Gateway не завершился. Проверьте доступность модели и баланс.',502);
    const result=await response.json();if(!result.choices?.length)throw new DomainError('EMPTY_MODEL_RESPONSE','Gateway не вернул проверочный ответ.');
    await recordModelCheck(workspaceId,{ok:true,model});return finish({ok:true,test:false,message:'Проверочный запрос выполнен. Он мог расходовать токены.',usage:result.usage||null},result.usage);
  }catch(error){const e=error as Error;await recordModelCheck(workspaceId,{ok:false,model,error:error instanceof DomainError?e.message:'Сервис модели недоступен.'});await finish({error:{code:error instanceof DomainError?error.code:'MODEL_CHECK_FAILED',message:error instanceof DomainError?e.message:'Сервис модели недоступен.'}});throw error;}
}
