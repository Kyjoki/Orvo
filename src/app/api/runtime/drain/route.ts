import {isInternalRequest} from '@/server/internal-auth';
import {getWorkspace} from '@/server/domain';
import {drainRuntime} from '@/server/runtime-outbox';
import {failure} from '@/server/http';
export const runtime='nodejs';
export async function POST(request:Request){
 if(!isInternalRequest(request))return Response.json({error:{code:'FORBIDDEN',message:'Runtime authentication required.'}},{status:403});
 try{const workspace=await getWorkspace();await drainRuntime(workspace.id);return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});}catch(error){return failure(error);}
}
