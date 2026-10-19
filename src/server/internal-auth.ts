import {timingSafeEqual} from 'node:crypto';
export function isInternalRequest(request:Request){
 const secret=process.env.ORVO_RUNTIME_SECRET;
 const value=request.headers.get('authorization')?.replace(/^Bearer /i,'')||'';
 return !!secret&&secret.length>=32&&Buffer.byteLength(secret)===Buffer.byteLength(value)&&timingSafeEqual(Buffer.from(secret),Buffer.from(value));
}
