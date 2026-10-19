import { requireOwnerSession, failure } from '@/server/http';
import { mfaStatus } from '@/server/mfa';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  try {const {session}=await requireOwnerSession(request);return Response.json(await mfaStatus(session),{headers:{'Cache-Control':'no-store'}});}
  catch(error){return failure(error);}
}
