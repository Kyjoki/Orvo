import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

process.env.ORVO_TEST_MODE = '1';
delete process.env.DATABASE_URL;
process.env.ORVO_TEST_DB_NAME = `watch-review-${process.pid}-${randomUUID().slice(0, 8)}`;
process.env.ORVO_WORKSPACE_ID = `watch-review-${process.pid}`;
process.env.ORVO_RUNTIME_SECRET = 'synthetic-review-secret-000000000000000000';

const { getWorkspace } = await import('../src/server/domain');
const { getDatabase, query } = await import('../src/server/db');
const { recordWatchCandidate, finishWatchCandidate, listWatchCandidates, rateWatchCandidate,
  watchReviewActive, reviewedWatchExamples } = await import('../src/server/watch-candidate-review');
const { watchFeedbackInstructions } = await import('../src/server/watch-feedback');
const workspace = await getWorkspace();

after(async () => { const database = await getDatabase(); if (database.kind === 'pglite') await database.db.close(); });

const inDay = new Date('2026-10-23T05:00:00.000Z');
const event = () => ({ eventId: randomBytes(32).toString('hex'), chatTitle: 'Клиент +7 777 111 22 33',
  pinned: true, excerpts: ['Терминал не работает, помощь нужна сейчас https://example.com/private'],
  reason: 'pinned-request' as const, observedAt: inDay.toISOString(), level: 'balanced' as const });

test('the review window follows the work timezone and ignores other days', async () => {
  assert.equal(watchReviewActive(new Date('2026-10-22T18:59:59Z')), false);
  assert.equal(watchReviewActive(new Date('2026-10-22T19:00:00Z')), true);
  assert.equal(watchReviewActive(new Date('2026-10-23T18:59:59Z')), true);
  assert.equal(watchReviewActive(new Date('2026-10-23T19:00:00Z')), false);
  assert.equal(await recordWatchCandidate(workspace.id, event(), new Date('2026-10-22T05:00:00Z')), false);
});

test('candidate is encrypted, redacted, deduplicated, rated and scoped to owner workspace', async () => {
  const candidate = event();
  assert.equal(await recordWatchCandidate(workspace.id, candidate, inDay), true);
  assert.equal(await recordWatchCandidate(workspace.id, candidate, inDay), false);
  await finishWatchCandidate(workspace.id, candidate.eventId, 'ignored');
  const stored = (await query<{ ciphertext: string; status: string }>(
    'SELECT ciphertext,status FROM watch_candidate_reviews WHERE workspace_id=$1 AND event_id=$2',
    [workspace.id, candidate.eventId])).rows[0];
  assert.equal(stored.status, 'ignored');
  assert.equal(stored.ciphertext.includes('Терминал'), false);
  const page = await listWatchCandidates(workspace.id, 0, inDay);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].status, 'ignored');
  assert.match(page.items[0].chatTitle, /\[номер скрыт\]/);
  assert.match(page.items[0].excerpts[0], /\[ссылка скрыта\]/);
  assert.equal(page.items[0].excerpts[0].includes('example.com'), false);
  const rated = await rateWatchCandidate(workspace.id, candidate.eventId, 'important',
    'Клиент ждёт, проблема с оплатой ещё не решена; звонить +7 777 111 22 33');
  assert.match(rated.explanation, /\[номер скрыт\]/);
  const encryptedAfterRating = (await query<{ ciphertext: string }>(
    'SELECT ciphertext FROM watch_candidate_reviews WHERE workspace_id=$1 AND event_id=$2',
    [workspace.id, candidate.eventId])).rows[0];
  assert.equal(encryptedAfterRating.ciphertext.includes('Клиент ждёт'), false);
  const reviewed = (await reviewedWatchExamples(workspace.id))[0];
  assert.equal(reviewed.label, 'important');
  assert.match(reviewed.explanation, /проблема с оплатой/);
  const instructions = await watchFeedbackInstructions(workspace.id, {
    chatTitle: 'Другая компания', pinned: false, excerpts: ['У стойки очередь, экран замер'],
  });
  assert.match(instructions, /почему владелец так решил: Клиент ждёт/);
  assert.equal(instructions.includes('777 111'), false);
  assert.equal((await listWatchCandidates('other-workspace', 0, inDay)).items.length, 0);
});

test('expired candidates cannot be reviewed and are purged on access', async () => {
  const candidate = event();
  await recordWatchCandidate(workspace.id, candidate, inDay);
  const later = new Date(inDay.getTime() + 8 * 86400_000);
  assert.equal((await listWatchCandidates(workspace.id, 0, later)).items.length, 0);
  await assert.rejects(rateWatchCandidate(workspace.id, candidate.eventId, 'noise'));
});
