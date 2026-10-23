import { z } from 'zod';
import { failure, readJson } from '@/server/http';
import { getWorkspace } from '@/server/domain';
import { clientAddress, consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';
import { requireWatchConnection } from '@/server/watch-connection';
import { watchConnectionGenerationIsCurrent } from '@/server/watch-connection-generation';
import { recordWatchCandidate, watchReviewActive } from '@/server/watch-candidate-review';
import { watchEventsEnabled, watchOriginAllowed } from '@/server/watch-events';
import { DomainError } from '@/shared/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

const observationSchema = z.object({
  eventId: z.string().regex(/^[a-f0-9]{64}$/),
  chatTitle: z.string().trim().min(1).max(120),
  pinned: z.boolean(),
  excerpts: z.array(z.string().trim().min(1).max(500)).length(1),
  reason: z.literal('observation'),
  observedAt: z.iso.datetime({ offset: true }),
  level: z.enum(['urgent', 'balanced', 'broad']),
}).strict();

export async function POST(request: Request) {
  try {
    if (!watchOriginAllowed(request.headers.get('origin'))) {
      throw new DomainError('WATCH_ORIGIN_REJECTED', 'Недопустимый источник запроса.', 403);
    }
    await consumeRateLimit('watch-observations-address', clientAddress(request), 120, 60);
    const workspace = await getWorkspace();
    const generation = await requireWatchConnection(workspace.id, request.headers.get('authorization'));
    if (!watchEventsEnabled() || !watchReviewActive()) {
      return Response.json({ accepted: false, status: 'disabled' }, { headers });
    }
    await consumeRateLimit('watch-observations-workspace', workspace.id, 1000, 3600);
    const event = observationSchema.parse(await readJson(request, 4096));
    if (!(await watchConnectionGenerationIsCurrent(workspace.id, generation))) {
      return Response.json({ accepted: false, status: 'disabled' }, { headers });
    }
    const recorded = await recordWatchCandidate(workspace.id, event);
    return Response.json({ accepted: true, status: recorded ? 'observed' : 'duplicate' }, { status: 202, headers });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}
