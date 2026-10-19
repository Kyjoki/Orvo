import { createHash, timingSafeEqual } from 'node:crypto';
import { reconcileRuntimeOutbox } from '@/server/runtime-queue';
import { failure } from '@/server/http';

export const runtime='nodejs';
export const maxDuration=60;

export function validReconcileRequest(request:Request,secret=process.env.ORVO_RECONCILE_SECRET){
  if(!secret || secret.length<32)return false;
  const provided=request.headers.get('x-orvo-reconcile-secret')||'';
  const expectedHash=createHash('sha256').update(secret).digest();
  const providedHash=createHash('sha256').update(provided).digest();
  return timingSafeEqual(expectedHash,providedHash);
}

export async function POST(request:Request){
  if(!validReconcileRequest(request))return Response.json({error:{code:'FORBIDDEN'}},{status:403});
  try{return Response.json({ok:true,...await reconcileRuntimeOutbox()},{headers:{'Cache-Control':'no-store'}});}
  catch(error){return failure(error);}
}
