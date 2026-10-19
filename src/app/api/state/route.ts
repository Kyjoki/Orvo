import { getSnapshot } from '@/server/domain';
import { requireOwner, failure } from '@/server/http';
import { drainRuntime } from '@/server/runtime-outbox';
import { after } from 'next/server';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try { const {workspace} = await requireOwner(request); after(()=>drainRuntime(workspace.id)); return Response.json(await getSnapshot(workspace.id),{headers:{'Cache-Control':'no-store'}}); }
  catch(error) { return failure(error); }
}
