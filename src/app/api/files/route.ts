import { requireOwner, assertOrigin, failure, readJson } from '@/server/http';
import { registerFile, completeFile } from '@/server/files';
import { consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';
export const runtime='nodejs';
export async function POST(request:Request){try{assertOrigin(request);const{workspace,session}=await requireOwner(request);await consumeRateLimit('files-write-owner',session.user.id,60,60);const p=await readJson(request,16384);return Response.json(p.type==='complete'?await completeFile(workspace.id,p.id):await registerFile(workspace.id,p));}catch(error){return rateLimitFailure(error) ?? failure(error);}}
