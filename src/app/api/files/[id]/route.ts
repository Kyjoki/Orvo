import { requireOwner, assertOrigin, failure } from '@/server/http';
import { downloadFileStream, putLocalFile } from '@/server/files';
import { consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';
export const runtime='nodejs';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{const{workspace,session}=await requireOwner(request);await consumeRateLimit('files-read-owner',session.user.id,120,60);const file=await downloadFileStream(workspace.id,(await params).id);return new Response(file.body,{headers:{'Content-Type':file.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}catch(error){return rateLimitFailure(error) ?? failure(error);}}
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){try{assertOrigin(request);const{workspace,session}=await requireOwner(request);await consumeRateLimit('files-write-owner',session.user.id,60,60);await putLocalFile(workspace.id,(await params).id,request);return Response.json({ok:true});}catch(error){return rateLimitFailure(error) ?? failure(error);}}
