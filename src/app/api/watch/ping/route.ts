import { failure } from '@/server/http';
import { getWorkspace } from '@/server/domain';
import { consumeRateLimit, clientAddress, rateLimitFailure } from '@/server/rate-limit';
import { requireWatchConnection } from '@/server/watch-connection';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    await consumeRateLimit('watch-ping', clientAddress(request), 20, 60);
    const workspace = await getWorkspace();
    await requireWatchConnection(workspace.id, request.headers.get('authorization'));
    return Response.json({ connected: true, dataTransferEnabled: false }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}
