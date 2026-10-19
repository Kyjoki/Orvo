import { getAuth } from '@/server/auth';
import { assertOrigin, requireOwner, failure } from '@/server/http';
export async function GET(request:Request){try{await requireOwner(request);return Response.json({authenticated:true},{headers:{'Cache-Control':'no-store'}});}catch(error){return failure(error);}}
export async function DELETE(request:Request){try{assertOrigin(request);return(await getAuth()).api.signOut({headers:request.headers,asResponse:true});}catch(error){return failure(error);}}
