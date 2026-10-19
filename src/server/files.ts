import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { query } from './db';
import { DomainError } from '../shared/types';
const MAX_SIZE=10*1024*1024;
const local=()=>process.env.ORVO_TEST_MODE==='1';
const bucket=()=>process.env.S3_BUCKET;
function s3() {
  if(!bucket()||!process.env.S3_ACCESS_KEY_ID||!process.env.S3_SECRET_ACCESS_KEY) throw new DomainError('STORAGE_NOT_CONFIGURED','Подключите закрытое объектное хранилище для вложений.',503);
  return new S3Client({region:process.env.S3_REGION||'auto',endpoint:process.env.S3_ENDPOINT||undefined,forcePathStyle:!!process.env.S3_ENDPOINT,credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}});
}
function filePath(id:string){ if(!/^[a-f0-9-]{36}$/.test(id)) throw new DomainError('NOT_FOUND','Файл не найден.',404); return path.join(process.cwd(),'.orvo','test-files',id); }
async function owned(workspaceId:string,id:string){const row=(await query('SELECT * FROM attachments WHERE id=$1 AND workspace_id=$2',[id,workspaceId])).rows[0];if(!row)throw new DomainError('NOT_FOUND','Файл не найден.',404);return row;}
export async function registerFile(workspaceId:string,p:any) {
  const name=String(p.name||'').replace(/[^\p{L}\p{N}._ -]/gu,'_').slice(0,150);
  if(!/\.(txt|md|pdf)$/i.test(name)||!Number.isInteger(p.size)||p.size<1||p.size>MAX_SIZE)throw new DomainError('INVALID_FILE','Допустимы TXT, Markdown и PDF до 10 МБ.');
  const counts=(await query('SELECT count(*)::int AS count FROM attachments WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(counts.count>=500)throw new DomainError('FILE_LIMIT','Достигнут лимит 500 файлов пространства.');
  if(p.taskId){const task=(await query('SELECT id FROM tasks WHERE id=$1 AND workspace_id=$2',[p.taskId,workspaceId])).rows[0];if(!task)throw new DomainError('NOT_FOUND','Задача не найдена.',404);}
  const id=crypto.randomUUID(), token=randomBytes(32).toString('base64url'), key=`${workspaceId}/${id}`;
  const data={name,size:p.size,mime:/\.pdf$/i.test(name)?'application/pdf':'text/plain',key,status:'uploading',test:local(),expiresAt:new Date(Date.now()+15*60000).toISOString(),tokenHash:createHash('sha256').update(token).digest('hex')};
  const uploadUrl=local()?`/api/files/${id}?token=${token}`:await getSignedUrl(s3(),new PutObjectCommand({Bucket:bucket(),Key:key,ContentType:data.mime}),{expiresIn:900});
  await query('INSERT INTO attachments(id,workspace_id,task_id,data) VALUES($1,$2,$3,$4)',[id,workspaceId,p.taskId||null,JSON.stringify(data)]);
  return {id,uploadUrl,method:'PUT',headers:{'Content-Type':data.mime}};
}
export async function putLocalFile(workspaceId:string,id:string,request:Request) {
  if(!local())throw new DomainError('NOT_AVAILABLE','Используйте прямую загрузку в закрытое хранилище.',404);
  const row=await owned(workspaceId,id),data=row.data;
  const token=new URL(request.url).searchParams.get('token')||'';
  if(data.status!=='uploading'||Date.parse(data.expiresAt)<Date.now()||createHash('sha256').update(token).digest('hex')!==data.tokenHash)throw new DomainError('UPLOAD_EXPIRED','Разрешение загрузки истекло.',409);
  const chunks:Uint8Array[]=[];let size=0;const reader=request.body?.getReader();
  if(!reader)throw new DomainError('EMPTY_FILE','Файл пуст.');
  while(true){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_SIZE){await reader.cancel();throw new DomainError('FILE_TOO_LARGE','Файл превышает 10 МБ.');}chunks.push(value);}
  if(size!==data.size)throw new DomainError('INVALID_FILE_SIZE','Размер загрузки не совпадает.');
  await mkdir(path.dirname(filePath(id)),{recursive:true});await writeFile(filePath(id),Buffer.concat(chunks),{flag:'wx',mode:0o600});
}
async function bytes(row:any){if(row.data.test)return readFile(filePath(row.id));const response=await s3().send(new GetObjectCommand({Bucket:bucket(),Key:row.data.key}));if((response.ContentLength||0)>MAX_SIZE)throw new DomainError('FILE_TOO_LARGE','Файл превышает лимит.');return Buffer.from(await response.Body!.transformToByteArray());}
export async function completeFile(workspaceId:string,id:string){
  const row=await owned(workspaceId,id);if(row.data.status==='ready')return{attachment:{id,...row.data}};
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
    if(!row.data.test){key=`${workspaceId}/sealed/${crypto.randomUUID()}`;const client=s3();await client.send(new PutObjectCommand({Bucket:bucket(),Key:key,ContentType:row.data.mime,Body:content}));await client.send(new DeleteObjectCommand({Bucket:bucket(),Key:row.data.key})).catch(()=>{});}
    const data={...row.data,key,status:'ready',text,tokenHash:undefined};await query('UPDATE attachments SET data=$1 WHERE id=$2 AND workspace_id=$3',[JSON.stringify(data),id,workspaceId]);return{attachment:{id,...data}};
  }catch(error){await query('UPDATE attachments SET data=$1 WHERE id=$2',[JSON.stringify({...row.data,status:'error',error:error instanceof DomainError?error.message:'Не удалось обработать файл.'}),id]);throw error;}
}
export async function downloadFile(workspaceId:string,id:string){
  const result=(await query('SELECT * FROM artifacts WHERE id=$1 AND workspace_id=$2',[id,workspaceId])).rows[0];
  if(result)return{body:Buffer.from(result.data.text||'','utf8'),name:result.data.filename||'result.md',mime:'text/markdown; charset=utf-8'};
  const row=await owned(workspaceId,id);if(row.data.status!=='ready')throw new DomainError('FILE_NOT_READY','Файл ещё не готов.',409);
  return{body:await bytes(row),name:row.data.name,mime:row.data.mime};
}
