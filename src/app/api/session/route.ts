import { getAuth } from '@/server/auth';
import { assertOrigin, requireOwnerSession, failure } from '@/server/http';
import { mfaStatus } from '@/server/mfa';
export async function GET(request:Request){try{const {session}=await requireOwnerSession(request);return Response.json({authenticated:true,mfa:await mfaStatus(session)},{headers:{'Cache-Control':'no-store'}});}catch(error){return failure(error);}}
export async function DELETE(request:Request){try{assertOrigin(request);return(await getAuth()).api.signOut({headers:request.headers,asResponse:true});}catch(error){return failure(error);}}
