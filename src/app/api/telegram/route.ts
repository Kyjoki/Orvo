import { z } from 'zod';
import { assertOrigin, failure, readJson, requireOwner } from '@/server/http';
import { consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';
import { disconnectTelegram, pairTelegram, sendTelegramTest, telegramStatus } from '@/server/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pair'), code: z.string().length(24) }).strict(),
  z.object({ action: z.literal('test') }).strict(),
  z.object({ action: z.literal('disconnect') }).strict(),
]);

export async function GET(request: Request) {
  try {
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('telegram-status', session.user.id, 30, 60);
    return Response.json(await telegramStatus(workspace.id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}

export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('telegram-action', session.user.id, 5, 900);
    const input = requestSchema.parse(await readJson(request, 1024));
    const result = input.action === 'pair' ? await pairTelegram(workspace.id, input.code)
      : input.action === 'test' ? await sendTelegramTest(workspace.id)
      : await disconnectTelegram(workspace.id);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}
