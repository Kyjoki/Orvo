import { requireOwner, assertOrigin, failure } from '@/server/http';
import { downloadFile, putLocalFile } from '@/server/files';
export const runtime='nodejs';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{const{workspace}=await requireOwner(request);const file=await downloadFile(workspace.id,(await params).id);return new Response(new Uint8Array(file.body),{headers:{'Content-Type':file.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}catch(error){return failure(error);}}
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){try{assertOrigin(request);const{workspace}=await requireOwner(request);await putLocalFile(workspace.id,(await params).id,request);return Response.json({ok:true});}catch(error){return failure(error);}}
