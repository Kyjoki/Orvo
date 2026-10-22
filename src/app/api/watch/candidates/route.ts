import { assertOrigin, failure, readJson, requireOwner } from '@/server/http';
import { consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';
import { listWatchCandidates, rateWatchCandidate, watchCandidateRatingInput, WATCH_REVIEW_DAY } from '@/server/watch-candidate-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('watch-candidates-read', session.user.id, 60, 60);
    const offsetText = new URL(request.url).searchParams.get('offset') ?? '0';
    if (!/^(0|[1-9]\d{0,4})$/.test(offsetText)) return Response.json({ error: { message: 'Некорректная страница.' } }, { status: 400, headers });
    return Response.json({ day: WATCH_REVIEW_DAY, ...await listWatchCandidates(workspace.id, Number(offsetText)) }, { headers });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}

export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const { workspace, session } = await requireOwner(request);
    await consumeRateLimit('watch-candidates-rate', session.user.id, 120, 3600);
    const input = watchCandidateRatingInput.parse(await readJson(request, 256));
    return Response.json(await rateWatchCandidate(workspace.id, input.eventId, input.label), { headers });
  } catch (error) { return rateLimitFailure(error) ?? failure(error); }
}
