import { failure, readJson } from '@/server/http';
import { getWorkspace } from '@/server/domain';
import { clientAddress, consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';
import { requireWatchConnection } from '@/server/watch-connection';
import { processWatchEvent, watchEventSchema, watchEventsEnabled, watchOriginAllowed } from '@/server/watch-events';
import { finishWatchCandidate, recordWatchCandidate } from '@/server/watch-candidate-review';
import { watchConnectionGenerationIsCurrent } from '@/server/watch-connection-generation';
import { DomainError } from '@/shared/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  try {
    if (!watchOriginAllowed(request.headers.get('origin'))) {
      throw new DomainError('WATCH_ORIGIN_REJECTED', 'Недопустимый источник запроса.', 403);
    }
    await consumeRateLimit('watch-events-address', clientAddress(request), 120, 60);
    const workspace = await getWorkspace();
    const connectionGeneration = await requireWatchConnection(workspace.id, request.headers.get('authorization'));
    if (!watchEventsEnabled()) {
      return Response.json({ accepted: false, status: 'disabled' }, { headers });
    }
    await consumeRateLimit('watch-events-workspace', workspace.id, 180, 3600);
    const input = watchEventSchema.parse(await readJson(request, 8192));
    const current = await watchConnectionGenerationIsCurrent(workspace.id, connectionGeneration);
    const recorded = current && await recordWatchCandidate(workspace.id, input);
    try {
      const result = await processWatchEvent(workspace.id, input, connectionGeneration);
      if (recorded) await finishWatchCandidate(workspace.id, input.eventId, result.status);
      return Response.json(result, { status: result.accepted ? 202 : 200, headers });
    } catch (error) {
      if (recorded) await finishWatchCandidate(workspace.id, input.eventId, 'error');
      throw error;
    }
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}
