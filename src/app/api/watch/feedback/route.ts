import { z } from 'zod';
import { assertOrigin, failure, readJson, requireOwner } from '@/server/http';
import { consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';
import { addWatchFeedback, deleteWatchFeedback, listWatchFeedback, watchFeedbackInput } from '@/server/watch-feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('watch-feedback-read', session.user.id, 30, 60);
    return Response.json({ examples: await listWatchFeedback(workspace.id) }, { headers });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}

export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('watch-feedback-write', session.user.id, 30, 3600);
    const input = watchFeedbackInput.parse(await readJson(request, 2048));
    return Response.json(await addWatchFeedback(workspace.id, input), { status: 201, headers });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}

export async function DELETE(request: Request) {
  try {
    assertOrigin(request);
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('watch-feedback-write', session.user.id, 30, 3600);
    const { id } = z.object({ id: z.uuid() }).strict().parse(await readJson(request, 256));
    return Response.json({ deleted: await deleteWatchFeedback(workspace.id, id) }, { headers });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}
