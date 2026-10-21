import { assertOrigin, failure, requireOwner } from '@/server/http';
import { consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';
import { createWatchConnection, revokeWatchConnection, watchConnectionStatus } from '@/server/watch-connection';
import { watchEventsReady } from '@/server/watch-events';
import { watchUsageStatus } from '@/server/watch-usage';
import { watchAlertCounts } from '@/server/watch-outbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

async function details(workspaceId: string, connection: Awaited<ReturnType<typeof watchConnectionStatus>>) {
  return { ...connection, dataTransferEnabled: connection.connected && await watchEventsReady(workspaceId),
    usage: await watchUsageStatus(workspaceId), alerts: await watchAlertCounts(workspaceId) };
}

export async function GET(request: Request) {
  try {
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('watch-status', session.user.id, 30, 60);
    return Response.json(await details(workspace.id, await watchConnectionStatus(workspace.id)), { headers });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}

export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('watch-pair', session.user.id, 3, 3600);
    return Response.json(await details(workspace.id, await createWatchConnection(workspace.id)), { headers });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}

export async function DELETE(request: Request) {
  try {
    assertOrigin(request);
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('watch-pair', session.user.id, 3, 3600);
    return Response.json(await details(workspace.id, await revokeWatchConnection(workspace.id)), { headers });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}
