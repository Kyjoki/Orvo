import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

process.env.ORVO_TEST_MODE = '1';
delete process.env.DATABASE_URL;
delete process.env.ORVO_TEST_DB_DIR;
process.env.ORVO_TEST_DB_NAME = `watch-budget-${process.pid}-${randomUUID().slice(0, 8)}`;
process.env.ORVO_WORKSPACE_ID = `watch-budget-${process.pid}`;

const { getWorkspace } = await import('../src/server/domain');
const { getDatabase, query } = await import('../src/server/db');
const { reserveWatchBudget, settleWatchBudget, watchPeriod,
  WATCH_MONTHLY_BUDGET_MICRO_USD, WATCH_MONTHLY_EVENT_LIMIT,
  watchActualMicroUsd, watchReservationMicroUsd } = await import('../src/server/watch-budget');
const workspace = await getWorkspace();
const eventId = (value: string) => createHash('sha256').update(value).digest('hex');
after(async () => { const database = await getDatabase(); if (database.kind === 'pglite') await database.db.close(); });

test('accounting month follows the workspace time zone', () => {
  assert.equal(watchPeriod(new Date('2026-10-31T19:30:00Z')), '2026-11');
  assert.ok(watchReservationMicroUsd('инструкция', 'контекст') > watchActualMicroUsd(20, 100));
});

test('parallel replay claims one event and stores no chat content', async () => {
  const id = eventId('first');
  const reserved = watchReservationMicroUsd('policy', 'preview');
  const outcomes = await Promise.all([
    reserveWatchBudget(workspace.id, id, 'policy', 'preview'),
    reserveWatchBudget(workspace.id, id, 'policy', 'preview'),
  ]);
  assert.deepEqual(outcomes.sort(), ['duplicate', 'reserved']);
  const period = watchPeriod(new Date());
  const row = (await query('SELECT accepted_count,committed_micro_usd FROM watch_analysis_usage WHERE workspace_id=$1 AND period=$2',
    [workspace.id, period])).rows[0];
  assert.equal(Number(row.accepted_count), 1);
  assert.equal(Number(row.committed_micro_usd), reserved);
  await settleWatchBudget(workspace.id, id, { inputTokens: 20, outputTokens: 100 });
  await settleWatchBudget(workspace.id, id, { inputTokens: 1, outputTokens: 1 });
  const afterSettle = (await query('SELECT committed_micro_usd FROM watch_analysis_usage WHERE workspace_id=$1 AND period=$2',
    [workspace.id, period])).rows[0];
  assert.equal(Number(afterSettle.committed_micro_usd), watchActualMicroUsd(20, 100));
  const event = (await query('SELECT * FROM watch_analysis_events WHERE workspace_id=$1 AND event_id=$2', [workspace.id, id])).rows[0];
  assert.equal(event.actual_micro_usd, watchActualMicroUsd(20, 100));
  assert.equal(JSON.stringify(event).includes('first'), false);
});

test('monthly message and dollar caps reject new claims', async () => {
  const period = watchPeriod(new Date());
  const reserved = watchReservationMicroUsd('policy', 'preview');
  await query('UPDATE watch_analysis_usage SET accepted_count=$3 WHERE workspace_id=$1 AND period=$2',
    [workspace.id, period, WATCH_MONTHLY_EVENT_LIMIT]);
  assert.equal(await reserveWatchBudget(workspace.id, eventId('over-count'), 'policy', 'preview'), 'limit-reached');
  await query('UPDATE watch_analysis_usage SET accepted_count=1, committed_micro_usd=$3 WHERE workspace_id=$1 AND period=$2',
    [workspace.id, period, WATCH_MONTHLY_BUDGET_MICRO_USD - reserved + 1]);
  assert.equal(await reserveWatchBudget(workspace.id, eventId('over-money'), 'policy', 'preview'), 'limit-reached');
  assert.equal((await query('SELECT count(*)::integer AS count FROM watch_analysis_events WHERE workspace_id=$1',
    [workspace.id])).rows[0].count, 1);
  await query('UPDATE watch_analysis_usage SET committed_micro_usd=$3 WHERE workspace_id=$1 AND period=$2',
    [workspace.id, period, WATCH_MONTHLY_BUDGET_MICRO_USD - reserved]);
  const outcomes = await Promise.all([
    reserveWatchBudget(workspace.id, eventId('boundary-a'), 'policy', 'preview'),
    reserveWatchBudget(workspace.id, eventId('boundary-b'), 'policy', 'preview'),
  ]);
  assert.deepEqual(outcomes.sort(), ['limit-reached', 'reserved']);
});
