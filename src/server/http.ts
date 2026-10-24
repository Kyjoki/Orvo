import { getAuth } from './auth';
import { getWorkspaceForOwner } from './domain';
import {DomainError} from '../shared/types';
import { appOrigin } from './app-origin';
import { mfaStatus } from './mfa';
export async function requireOwnerSession(request: Request) {
  const session = await (await getAuth()).api.getSession({headers:request.headers});
  if (!session) throw Object.assign(new Error('Войдите в пространство Orvo.'), {code:'UNAUTHENTICATED',status:401});
  const cookie=request.headers.get('cookie')||'';
  const selected=cookie.split(';').map(part=>part.trim()).find(part=>part.startsWith('orvo-office='))?.slice('orvo-office='.length);
  let requestedId:string|null=null;
  if(selected){try{const value=decodeURIComponent(selected);if(value.length<=100)requestedId=value;}catch{}}
  let workspace:Awaited<ReturnType<typeof getWorkspaceForOwner>>;
  try{workspace=await getWorkspaceForOwner(session.user.id,requestedId);}
  catch(error){if(!requestedId||(error as {code?:string}).code!=='FORBIDDEN')throw error;workspace=await getWorkspaceForOwner(session.user.id);}
  return {session,workspace};
}
export async function requireOwner(request: Request) {
  const result=await requireOwnerSession(request);
  const mfa=await mfaStatus(result.session);
  if(mfa.setupRequired||mfa.stepUpRequired)throw new DomainError('MFA_REQUIRED','Подтвердите двухфакторную защиту, чтобы открыть офис.',403);
  return result;
}
export function assertOrigin(request: Request) {
  const expected = appOrigin();
  if (request.headers.get('origin') !== expected) throw Object.assign(new Error('Недопустимый источник запроса.'),{code:'INVALID_ORIGIN',status:403});
}
export function failure(error: unknown) {
  const e = error as {code?:string;status?:number;message?:string};
  const status = e.status || (e.code === 'UNAUTHENTICATED' ? 401 : 400);
  // Do not expose connection strings, provider responses, or SQL in browser errors.
  const safe = error instanceof DomainError || ['UNAUTHENTICATED','FORBIDDEN','INVALID_ORIGIN'].includes(e.code||'');
  return Response.json({error:{code:safe ? e.code : 'REQUEST_FAILED',message:safe ? e.message : 'Не удалось выполнить запрос. Проверьте настройки и повторите.'}},{status,headers:{'Cache-Control':'no-store'}});
}
export async function readJson(request:Request,limit:number){
 const reader=request.body?.getReader();if(!reader)throw new DomainError('INVALID_JSON','Тело запроса отсутствует.',400);
 const chunks:Uint8Array[]=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();throw new DomainError('BODY_TOO_LARGE','Превышен допустимый размер запроса.',413);}chunks.push(value);}}
 finally{reader.releaseLock();}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new DomainError('INVALID_JSON','Некорректный JSON запроса.',400);}
}
