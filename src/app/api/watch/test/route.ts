import { randomBytes } from 'node:crypto';
import { assertOrigin, failure, requireOwner } from '@/server/http';
import { consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';
import { currentWatchConnectionGeneration } from '@/server/watch-connection-generation';
import { processWatchEvent, watchEventsReady, watchMentionsReady, type WatchEvent } from '@/server/watch-events';
import { DomainError } from '@/shared/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Exercises the real delivery path with fixed fictional text only. */
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('watch-synthetic-test', session.user.id, 3, 3600);
    const kind = new URL(request.url).searchParams.get('kind');
    if (kind !== null && kind !== 'mention') {
      throw new DomainError('WATCH_TEST_INVALID_KIND', 'Неизвестный тип проверки.', 400);
    }
    const mention = kind === 'mention';
    if (!(await (mention ? watchMentionsReady(workspace.id) : watchEventsReady(workspace.id)))) {
      throw new DomainError('WATCH_TEST_UNAVAILABLE', 'Наблюдение пока не готово к проверке.', 503);
    }
    const generation = await currentWatchConnectionGeneration(workspace.id);
    if (!generation) throw new DomainError('WATCH_UNAUTHORIZED', 'Ключ расширения не создан.', 401);
    const event: WatchEvent = {
      eventId: randomBytes(32).toString('hex'),
      chatTitle: 'Тест Orvo — вымышленный чат',
      pinned: true,
      excerpts: [mention ? 'Тестовое упоминание: подскажите, как вернуть одно блюдо в меню.'
        : 'Срочно нужен специалист: терминал перестал принимать оплату. Клиенты ждут, проверьте подключение.'],
      reason: mention ? 'mention' : 'urgent',
      observedAt: new Date().toISOString(),
      level: 'urgent',
    };
    const result = await processWatchEvent(workspace.id, event, generation);
    return Response.json(result, { status: result.accepted ? 202 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}
