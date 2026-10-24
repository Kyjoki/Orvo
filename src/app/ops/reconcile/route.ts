import { reconcileRuntimeOutbox } from '@/server/runtime-queue';
import { drainWatchAlertOutbox } from '@/server/watch-outbox';
import { failure } from '@/server/http';
import { validReconcileRequest } from '@/server/reconcile-auth';

export const runtime='nodejs';
export const maxDuration=60;

export async function POST(request:Request){
  if(!validReconcileRequest(request))return Response.json({error:{code:'FORBIDDEN'}},{status:403});
  try{
    const [runtimeResult,watchResult]=await Promise.allSettled([reconcileRuntimeOutbox(),drainWatchAlertOutbox()]);
    if(runtimeResult.status==='rejected'||watchResult.status==='rejected')throw new Error('Reconciliation did not complete.');
    return Response.json({ok:true,...runtimeResult.value,watch:watchResult.value},{headers:{'Cache-Control':'no-store'}});
  }
  catch(error){return failure(error);}
}
