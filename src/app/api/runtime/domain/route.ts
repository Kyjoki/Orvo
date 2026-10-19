import { isInternalRequest } from '@/server/internal-auth';
import * as domain from '@/server/domain';
import {readJson,failure} from '@/server/http';
const allowed = ['prepareTask','getTask','setTaskStatus','recordTaskEvent','saveResult','failTask','claimTask','releaseTask','reserveUsage','settleUsage','createApproval','commitRuntimeId'] as const;
export const runtime='nodejs';
export async function POST(request:Request){
  if(!isInternalRequest(request))return Response.json({error:{code:'FORBIDDEN',message:'Runtime authentication required.'}},{status:403});
  try {
    const p=await readJson(request,150000);
    if(!allowed.includes(p.action)||!Array.isArray(p.args))return Response.json({error:{code:'INVALID_ACTION',message:'Unknown domain action.'}},{status:400});
    const fn=domain[p.action as typeof allowed[number]] as (...args:any[])=>Promise<any>;
    return Response.json({result:await fn(...p.args)},{headers:{'Cache-Control':'no-store'}});
  }catch(error){return failure(error);}
}
