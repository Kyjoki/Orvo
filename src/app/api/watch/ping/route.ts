import { failure } from '@/server/http';
import { getWorkspace } from '@/server/domain';
import { consumeRateLimit, clientAddress, rateLimitFailure } from '@/server/rate-limit';
import { requireWatchConnection } from '@/server/watch-connection';
import { watchEventsEnabled, watchEventsReady, watchMentionsReady } from '@/server/watch-events';
import { watchReviewActive } from '@/server/watch-candidate-review';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    // Every candidate is preflighted before any work-chat text leaves the browser.
    // Keep this above the event endpoint's 120/min safety cap so preflight
    // cannot discard an otherwise admissible urgent candidate first.
    await consumeRateLimit('watch-ping', clientAddress(request), 180, 60);
    const workspace = await getWorkspace();
    await requireWatchConnection(workspace.id, request.headers.get('authorization'));
    const [dataTransferEnabled, mentionTransferEnabled] = await Promise.all([
      watchEventsReady(workspace.id), watchMentionsReady(workspace.id),
    ]);
    return Response.json({ connected: true, dataTransferEnabled, mentionTransferEnabled,
      journalTransferEnabled: watchEventsEnabled() && watchReviewActive() }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}
