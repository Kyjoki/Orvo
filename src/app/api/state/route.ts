import { getSnapshot } from '@/server/domain';
import { requireOwner, failure } from '@/server/http';
import { drainRuntime } from '@/server/runtime-outbox';
import { after } from 'next/server';
import { consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try { const {workspace,session} = await requireOwner(request); await consumeRateLimit('state-owner',session.user.id,180,60); after(()=>drainRuntime(workspace.id)); return Response.json(await getSnapshot(workspace.id),{headers:{'Cache-Control':'no-store'}}); }
  catch(error) { return rateLimitFailure(error) ?? failure(error); }
}
