import { requireOwner, assertOrigin, failure, readJson } from '@/server/http';
import { registerFile, completeFile } from '@/server/files';
export const runtime='nodejs';
export async function POST(request:Request){try{assertOrigin(request);const{workspace}=await requireOwner(request);const p=await readJson(request,16384);return Response.json(p.type==='complete'?await completeFile(workspace.id,p.id):await registerFile(workspace.id,p));}catch(error){return failure(error);}}
