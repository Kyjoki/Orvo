import { createHash, timingSafeEqual } from 'node:crypto';
import { reconcileRuntimeOutbox } from '@/server/runtime-queue';
import { drainWatchAlertOutbox } from '@/server/watch-outbox';
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
  try{
    const [runtimeResult,watchResult]=await Promise.allSettled([reconcileRuntimeOutbox(),drainWatchAlertOutbox()]);
    if(runtimeResult.status==='rejected'||watchResult.status==='rejected')throw new Error('Reconciliation did not complete.');
    return Response.json({ok:true,...runtimeResult.value,watch:watchResult.value},{headers:{'Cache-Control':'no-store'}});
  }
  catch(error){return failure(error);}
}
