import { assertOrigin, failure, requireOwner } from '@/server/http';
import { consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';
import { createWatchConnection, revokeWatchConnection, watchConnectionStatus } from '@/server/watch-connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('watch-status', session.user.id, 30, 60);
    return Response.json(await watchConnectionStatus(workspace.id), { headers });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}

export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('watch-pair', session.user.id, 3, 3600);
    return Response.json(await createWatchConnection(workspace.id), { headers });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}

export async function DELETE(request: Request) {
  try {
    assertOrigin(request);
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('watch-pair', session.user.id, 3, 3600);
    return Response.json(await revokeWatchConnection(workspace.id), { headers });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}
