import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { query, transaction } from './db';
import { DomainError } from '../shared/types';
import { blobPath, privateUploadPermission, privateBlobStream, readPrivateBlob, sealPrivateBlob, discardPrivateBlob } from './blob-storage';
const MAX_SIZE=10*1024*1024;
type Storage='local'|'s3'|'blob';
const local=()=>process.env.ORVO_TEST_MODE==='1'&&!process.env.VERCEL;
const selectedStorage=():Storage=>local()?'local':process.env.VERCEL||process.env.ORVO_FILE_STORAGE==='blob'?'blob':'s3';
const rowStorage=(data:any):Storage=>data.storage||(data.test?'local':'s3');
const bucket=()=>process.env.S3_BUCKET;
function s3() {
  if(!bucket()||!process.env.S3_ACCESS_KEY_ID||!process.env.S3_SECRET_ACCESS_KEY) throw new DomainError('STORAGE_NOT_CONFIGURED','Подключите закрытое объектное хранилище для вложений.',503);
  return new S3Client({region:process.env.S3_REGION||'auto',endpoint:process.env.S3_ENDPOINT||undefined,forcePathStyle:!!process.env.S3_ENDPOINT,credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}});
}
function filePath(id:string){ if(!/^[a-f0-9-]{36}$/.test(id)) throw new DomainError('NOT_FOUND','Файл не найден.',404); return path.join(process.cwd(),'.orvo','test-files',id); }
async function owned(workspaceId:string,id:string){const row=(await query('SELECT * FROM attachments WHERE id=$1 AND workspace_id=$2',[id,workspaceId])).rows[0];if(!row)throw new DomainError('NOT_FOUND','Файл не найден.',404);return row;}
function assertStagingKey(workspaceId:string,row:any){
  const storage=rowStorage(row.data);
  if(storage==='blob'&&row.data.key!==blobPath(workspaceId,row.id,row.data.name,'staging'))throw new DomainError('CLEANUP_KEY_MISMATCH','Некорректный временный путь файла.');
  if(storage==='s3'&&row.data.key!==`${workspaceId}/${row.id}`)throw new DomainError('CLEANUP_KEY_MISMATCH','Некорректный временный путь файла.');
  return storage;
}
async function deleteStaging(workspaceId:string,row:any){
  const storage=assertStagingKey(workspaceId,row);
  if(storage==='blob')await discardPrivateBlob(row.data.key);
  else if(storage==='s3')await s3().send(new DeleteObjectCommand({Bucket:bucket(),Key:row.data.key}));
  else await unlink(filePath(row.id)).catch(error=>{if(error?.code!=='ENOENT')throw error;});
}
// Metadata is retained for history. Each invocation claims and deletes only a few
// unaccepted staging objects; a lease lets another invocation retry after a crash.
export async function cleanupStaleUploads(workspaceId:string,requestedLimit=3){
  const limit=Math.max(1,Math.min(5,Math.trunc(requestedLimit)||3));
  const candidates=(await query(`SELECT id FROM attachments WHERE workspace_id=$1
    AND ((data->>'status'='uploading' AND (data->>'expiresAt')::timestamptz < now()-interval '5 minutes') OR data->>'status' IN ('error','expired'))
    AND (data->>'cleanupState' IS NULL OR data->>'cleanupState'='pending' OR (data->>'cleanupState'='retry' AND (data->>'cleanupAfter')::timestamptz <= now()) OR (data->>'cleanupState'='processing' AND (data->>'cleanupLeaseUntil')::timestamptz <= now()))
    ORDER BY created_at ASC LIMIT $2`,[workspaceId,limit])).rows;
  let cleaned=0;
  for(const candidate of candidates){
    const leaseId=crypto.randomUUID();
    const claimed=(await query(`UPDATE attachments SET data=data || $3::jsonb || CASE WHEN data->>'status'='uploading' THEN '{"status":"expired"}'::jsonb ELSE '{}'::jsonb END WHERE id=$1 AND workspace_id=$2
      AND ((data->>'status'='uploading' AND (data->>'expiresAt')::timestamptz < now()-interval '5 minutes') OR data->>'status' IN ('error','expired'))
      AND (data->>'cleanupState' IS NULL OR data->>'cleanupState'='pending' OR (data->>'cleanupState'='retry' AND (data->>'cleanupAfter')::timestamptz <= now()) OR (data->>'cleanupState'='processing' AND (data->>'cleanupLeaseUntil')::timestamptz <= now())) RETURNING *`,[candidate.id,workspaceId,JSON.stringify({cleanupState:'processing',cleanupLeaseId:leaseId,cleanupLeaseUntil:new Date(Date.now()+5*60_000).toISOString()})])).rows[0];
    if(!claimed)continue;
    try{
      await deleteStaging(workspaceId,claimed);
      await query("UPDATE attachments SET data=data || $4::jsonb WHERE id=$1 AND workspace_id=$2 AND data->>'cleanupLeaseId'=$3 AND data->>'cleanupState'='processing'",[claimed.id,workspaceId,leaseId,JSON.stringify({cleanupState:'done',cleanupAt:new Date().toISOString(),cleanupLeaseUntil:null})]);
      cleaned++;
    }catch(error){
      const blocked=error instanceof DomainError&&error.code==='CLEANUP_KEY_MISMATCH';
      await query("UPDATE attachments SET data=data || $4::jsonb WHERE id=$1 AND workspace_id=$2 AND data->>'cleanupLeaseId'=$3 AND data->>'cleanupState'='processing'",[claimed.id,workspaceId,leaseId,JSON.stringify({cleanupState:blocked?'blocked':'retry',cleanupAfter:new Date(Date.now()+5*60_000).toISOString(),cleanupLeaseUntil:null})]);
    }
  }
  return cleaned;
}
export async function registerFile(workspaceId:string,p:any) {
  const name=String(p.name||'').replace(/[^\p{L}\p{N}._ -]/gu,'_').slice(0,150);
  if(!/\.(txt|md|pdf)$/i.test(name)||!Number.isInteger(p.size)||p.size<1||p.size>MAX_SIZE)throw new DomainError('INVALID_FILE','Допустимы TXT, Markdown и PDF до 10 МБ.');
  await cleanupStaleUploads(workspaceId).catch(()=>{});
  const id=crypto.randomUUID(),storage=selectedStorage(),token=storage==='local'?randomBytes(32).toString('base64url'):'';
  const key=storage==='blob'?blobPath(workspaceId,id,name,'staging'):`${workspaceId}/${id}`;
  const data={name,size:p.size,mime:/\.pdf$/i.test(name)?'application/pdf':'text/plain',key,storage,status:'uploading',test:storage==='local',expiresAt:new Date(Date.now()+15*60000).toISOString(),tokenHash:storage==='local'?createHash('sha256').update(token).digest('hex'):undefined};
  await transaction(async db=>{
    const workspace=(await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId])).rows[0];
    if(!workspace)throw new DomainError('NOT_FOUND','Пространство не найдено.',404);
    const counts=(await db.query(`SELECT count(*)::int AS count FROM attachments WHERE workspace_id=$1 AND
      (data->>'status'='ready' OR (data->>'status'='uploading' AND (data->>'expiresAt')::timestamptz > now()))`,[workspaceId])).rows[0];
    if(counts.count>=500)throw new DomainError('FILE_LIMIT','Достигнут лимит 500 активных файлов пространства.');
    if(p.taskId){const task=(await db.query('SELECT id FROM tasks WHERE id=$1 AND workspace_id=$2',[p.taskId,workspaceId])).rows[0];if(!task)throw new DomainError('NOT_FOUND','Задача не найдена.',404);}
    await db.query('INSERT INTO attachments(id,workspace_id,task_id,data) VALUES($1,$2,$3,$4)',[id,workspaceId,p.taskId||null,JSON.stringify(data)]);
  });
  try{
    const permission=storage==='local'?{uploadUrl:`/api/files/${id}?token=${token}`,method:'PUT' as const,headers:{'Content-Type':data.mime}}:storage==='blob'?await privateUploadPermission(key,p.size,data.mime,Date.parse(data.expiresAt)):{uploadUrl:await getSignedUrl(s3(),new PutObjectCommand({Bucket:bucket(),Key:key,ContentType:data.mime}),{expiresIn:900}),method:'PUT' as const,headers:{'Content-Type':data.mime}};
    return{id,...permission};
  }catch(error){
    await query("UPDATE attachments SET data=data || $3::jsonb WHERE id=$1 AND workspace_id=$2 AND data->>'status'='uploading'",[id,workspaceId,JSON.stringify({status:'error',error:'Не удалось выдать разрешение загрузки.',cleanupState:'pending'})]);
    throw error;
  }
}
export async function putLocalFile(workspaceId:string,id:string,request:Request) {
  const row=await owned(workspaceId,id),data=row.data;
  if(!local()||rowStorage(data)!=='local')throw new DomainError('NOT_AVAILABLE','Используйте прямую загрузку в закрытое хранилище.',404);
  const token=new URL(request.url).searchParams.get('token')||'';
  if(data.status!=='uploading'||Date.parse(data.expiresAt)<Date.now()||createHash('sha256').update(token).digest('hex')!==data.tokenHash)throw new DomainError('UPLOAD_EXPIRED','Разрешение загрузки истекло.',409);
  const chunks:Uint8Array[]=[];let size=0;const reader=request.body?.getReader();
  if(!reader)throw new DomainError('EMPTY_FILE','Файл пуст.');
  while(true){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_SIZE){await reader.cancel();throw new DomainError('FILE_TOO_LARGE','Файл превышает 10 МБ.');}chunks.push(value);}
  if(size!==data.size)throw new DomainError('INVALID_FILE_SIZE','Размер загрузки не совпадает.');
  await mkdir(path.dirname(filePath(id)),{recursive:true});await writeFile(filePath(id),Buffer.concat(chunks),{flag:'wx',mode:0o600});
}
async function bytes(row:any){const storage=rowStorage(row.data);if(storage==='local')return readFile(filePath(row.id));if(storage==='blob')return readPrivateBlob(row.data.key);const response=await s3().send(new GetObjectCommand({Bucket:bucket(),Key:row.data.key}));if((response.ContentLength||0)>MAX_SIZE)throw new DomainError('FILE_TOO_LARGE','Файл превышает лимит.');return Buffer.from(await response.Body!.transformToByteArray());}
export async function completeFile(workspaceId:string,id:string){
  const row=await owned(workspaceId,id);if(row.data.status==='ready')return{attachment:{id,...row.data}};
  if(row.data.status!=='uploading')throw new DomainError('FILE_NOT_READY','Файл не готов к проверке.',409);
  if(Date.parse(row.data.expiresAt)<Date.now())throw new DomainError('UPLOAD_EXPIRED','Загрузка истекла.',409);
  try {
    const content=await bytes(row);if(content.length!==row.data.size||content.length>MAX_SIZE)throw new DomainError('INVALID_FILE_SIZE','Размер загруженного файла не совпадает.');
    let text='';
    if(/\.pdf$/i.test(row.data.name)){
      if(content.subarray(0,5).toString()!=='%PDF-')throw new DomainError('INVALID_PDF','Формат файла не соответствует PDF.');
      const {PDFParse}=await import('pdf-parse');const parser=new PDFParse({data:content});try{text=(await parser.getText()).text;}finally{await parser.destroy();}
      if(text.trim().length<20)throw new DomainError('OCR_UNAVAILABLE','В PDF нет извлекаемого текста. OCR пока не подключён.');
    } else {
      try{text=new TextDecoder('utf-8',{fatal:true}).decode(content);}catch{throw new DomainError('INVALID_TEXT','Текст должен быть в кодировке UTF-8.');}
      if(text.includes('\0'))throw new DomainError('INVALID_TEXT','Двоичный файл не является текстом.');
    }
    if(text.length>50000)throw new DomainError('EXTRACTED_TEXT_LIMIT','Текст превышает лимит 50 000 символов. Сократите материал.');
    if(/(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*\S+)/i.test(text))throw new DomainError('SECRET_REJECTED','В материале обнаружен возможный секрет. Удалите ключи и пароли перед загрузкой.');
    // A presigned PUT remains reusable until expiry. Seal the exact validated
    // bytes under a fresh private key that is never exposed through a PUT URL.
    let key=row.data.key;
    const storage=rowStorage(row.data);
    if(storage==='blob')key=await sealPrivateBlob(blobPath(workspaceId,id,row.data.name,'sealed'),content,row.data.mime);
    if(storage==='s3'){key=`${workspaceId}/sealed/${crypto.randomUUID()}`;await s3().send(new PutObjectCommand({Bucket:bucket(),Key:key,ContentType:row.data.mime,Body:content}));}
    const data={...row.data,key,status:'ready',text,tokenHash:undefined};
    const updated=await query("UPDATE attachments SET data=$1 WHERE id=$2 AND workspace_id=$3 AND data->>'status'='uploading' RETURNING id",[JSON.stringify(data),id,workspaceId]);
    if(!updated.rows.length){const current=await owned(workspaceId,id);if(current.data.status==='ready')return{attachment:{id,...current.data}};throw new DomainError('FILE_NOT_READY','Файл не готов к проверке.',409);}
    if(storage==='blob')await discardPrivateBlob(row.data.key).catch(()=>{});
    if(storage==='s3')await s3().send(new DeleteObjectCommand({Bucket:bucket(),Key:row.data.key})).catch(()=>{});
    return{attachment:{id,...data}};
  }catch(error){await query("UPDATE attachments SET data=$1 WHERE id=$2 AND workspace_id=$3 AND data->>'status'='uploading'",[JSON.stringify({...row.data,status:'error',error:error instanceof DomainError?error.message:'Не удалось обработать файл.'}),id,workspaceId]);throw error;}
}
export async function downloadFile(workspaceId:string,id:string){
  const result=(await query('SELECT * FROM artifacts WHERE id=$1 AND workspace_id=$2',[id,workspaceId])).rows[0];
  if(result)return{body:Buffer.from(result.data.text||'','utf8'),name:result.data.filename||'result.md',mime:'text/markdown; charset=utf-8'};
  const row=await owned(workspaceId,id);if(row.data.status!=='ready')throw new DomainError('FILE_NOT_READY','Файл ещё не готов.',409);
  return{body:await bytes(row),name:row.data.name,mime:row.data.mime};
}
function bufferedStream(body:Buffer):ReadableStream<Uint8Array>{let offset=0;return new ReadableStream({pull(controller){if(offset>=body.length){controller.close();return;}const next=Math.min(offset+64*1024,body.length);controller.enqueue(new Uint8Array(body.subarray(offset,next)));offset=next;}});}
export async function downloadFileStream(workspaceId:string,id:string){
  const artifact=(await query('SELECT * FROM artifacts WHERE id=$1 AND workspace_id=$2',[id,workspaceId])).rows[0];
  if(artifact){const body=Buffer.from(artifact.data.text||'','utf8');return{body:bufferedStream(body),name:artifact.data.filename||'result.md',mime:'text/markdown; charset=utf-8'};}
  const row=await owned(workspaceId,id);if(row.data.status!=='ready')throw new DomainError('FILE_NOT_READY','Файл ещё не готов.',409);
  return{body:rowStorage(row.data)==='blob'?await privateBlobStream(row.data.key):bufferedStream(await bytes(row)),name:row.data.name,mime:row.data.mime};
}
