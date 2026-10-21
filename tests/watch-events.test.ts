import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { processWatchEvent, watchDecisionMatchesLevel, watchEventSchema, watchEventsEnabled, watchOriginAllowed } from '../src/server/watch-events';

const oldKey = process.env.OPENAI_API_KEY;
const oldFlag = process.env.ORVO_WATCH_EVENTS_ENABLED;
process.env.OPENAI_API_KEY = 'watch-unit-test-key';
process.env.ORVO_WATCH_EVENTS_ENABLED = '1';
after(() => {
  if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldKey;
  if (oldFlag === undefined) delete process.env.ORVO_WATCH_EVENTS_ENABLED;
  else process.env.ORVO_WATCH_EVENTS_ENABLED = oldFlag;
});

const event = watchEventSchema.parse({
  eventId: randomBytes(32).toString('hex'),
  chatTitle: 'Тестовый чат',
  pinned: true,
  excerpts: ['Терминал не работает, вызовите специалиста'],
  reason: 'pinned-request',
  observedAt: '2026-10-21T06:00:00.000Z',
  level: 'balanced',
});

test('server switch is off by default; origin and payload have narrow boundaries', () => {
  delete process.env.ORVO_WATCH_EVENTS_ENABLED;
  assert.equal(watchEventsEnabled(), false);
  process.env.ORVO_WATCH_EVENTS_ENABLED = '1';
  assert.equal(watchOriginAllowed(null), true);
  assert.equal(watchOriginAllowed(`chrome-extension://${'a'.repeat(32)}`), true);
  assert.equal(watchOriginAllowed('https://whatsapp.ailillu.kz'), false);
  assert.throws(() => watchEventSchema.parse({ ...event, eventId: 'a'.repeat(8) }));
  assert.throws(() => watchEventSchema.parse({ ...event, excerpts: Array(6).fill('text') }));
});

test('stale changes and an unpaired Telegram make no model call', async () => {
  let calls = 0;
  const deps = {
    isTelegramReady: async () => { calls++; return false; },
    isOutboxReady: () => true,
    reserve: async () => { calls++; return 'reserved' as const; },
    generate: async () => { calls++; return { text: '{}', usage: { inputTokens: 1, outputTokens: 1 } }; },
    settle: async () => { calls++; },
    enqueue: async () => { calls++; return true; },
    deliver: async () => { calls++; return 'delivered' as const; },
  };
  assert.deepEqual(await processWatchEvent('workspace', event, deps, new Date('2026-10-21T06:11:00Z')),
    { accepted: false, status: 'stale' });
  assert.equal(calls, 0);
  await assert.rejects(processWatchEvent('workspace', event, deps, new Date('2026-10-21T06:01:00Z')),
    { code: 'WATCH_TELEGRAM_UNAVAILABLE' });
  assert.equal(calls, 1);
});

test('one fresh event can notify; duplicate never calls the model twice', async () => {
  const calls: string[] = [];
  const deps = {
    isTelegramReady: async () => true,
    isOutboxReady: () => true,
    reserve: async () => { calls.push('reserve'); return calls.filter(v => v === 'reserve').length === 1 ? 'reserved' as const : 'duplicate' as const; },
    generate: async () => { calls.push('model'); return {
      text: JSON.stringify({ priority: 'urgent', confidence: 0.96, summary: 'Нужен специалист для терминала', reason: 'Прямой вызов' }),
      usage: { inputTokens: 300, outputTokens: 70 },
    }; },
    settle: async () => { calls.push('settle'); },
    enqueue: async (_workspaceId: string, _eventId: string, message: string) => { calls.push('enqueue'); assert.match(message, /Нужен специалист/); return true; },
    deliver: async () => { calls.push('telegram'); return 'delivered' as const; },
  };
  const now = new Date('2026-10-21T06:01:00Z');
  assert.deepEqual(await processWatchEvent('workspace', event, deps, now), { accepted: true, status: 'delivered' });
  assert.deepEqual(await processWatchEvent('workspace', event, deps, now), { accepted: false, status: 'duplicate' });
  assert.deepEqual(calls, ['reserve', 'model', 'settle', 'enqueue', 'telegram', 'reserve']);
});

test('notification level suppresses unpinned routine tasks', () => {
  const action = { priority: 'action' as const, confidence: 0.9, summary: 'Проверить меню', reason: 'Просьба' };
  assert.equal(watchDecisionMatchesLevel(action, { ...event, level: 'urgent' }), false);
  assert.equal(watchDecisionMatchesLevel(action, { ...event, level: 'balanced', pinned: false }), false);
  assert.equal(watchDecisionMatchesLevel(action, { ...event, level: 'broad', pinned: false }), true);
});

test('unknown model outcome retains claim and never sends Telegram', async () => {
  const calls: string[] = [];
  const deps = {
    isTelegramReady: async () => true,
    isOutboxReady: () => true,
    reserve: async () => { calls.push('reserve'); return 'reserved' as const; },
    generate: async () => { calls.push('model'); throw new Error('Private provider response'); },
    settle: async () => { calls.push('settle'); },
    enqueue: async () => { calls.push('enqueue'); return true; },
    deliver: async () => { calls.push('telegram'); return 'delivered' as const; },
  };
  await assert.rejects(processWatchEvent('workspace', event, deps, new Date('2026-10-21T06:01:00Z')),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'WATCH_MODEL_UNAVAILABLE');
      assert.doesNotMatch(String(error), /Private provider response/);
      return true;
    });
  assert.deepEqual(calls, ['reserve', 'model']);
});
