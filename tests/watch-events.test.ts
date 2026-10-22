import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { processWatchEvent, watchDecisionMatchesLevel, watchEventSchema, watchEventsEnabled, watchOriginAllowed } from '../src/server/watch-events';
import { loadWatchProfile, watchSystemInstructions, type WatchProfile } from '../src/server/watch-profile';

process.env.ORVO_TEST_MODE = '1';
delete process.env.DATABASE_URL;
process.env.ORVO_TEST_DB_NAME = `watch-profile-${process.pid}-${randomUUID().slice(0, 8)}`;
process.env.ORVO_WORKSPACE_ID = `watch-profile-${process.pid}`;

const oldKey = process.env.ORVO_WATCH_OPENAI_API_KEY;
const oldFlag = process.env.ORVO_WATCH_EVENTS_ENABLED;
const oldAgentId = process.env.ORVO_WATCH_AGENT_ID;
process.env.ORVO_WATCH_OPENAI_API_KEY = 'watch-unit-test-key';
process.env.ORVO_WATCH_EVENTS_ENABLED = '1';
after(() => {
  if (oldKey === undefined) delete process.env.ORVO_WATCH_OPENAI_API_KEY;
  else process.env.ORVO_WATCH_OPENAI_API_KEY = oldKey;
  if (oldFlag === undefined) delete process.env.ORVO_WATCH_EVENTS_ENABLED;
  else process.env.ORVO_WATCH_EVENTS_ENABLED = oldFlag;
  if (oldAgentId === undefined) delete process.env.ORVO_WATCH_AGENT_ID;
  else process.env.ORVO_WATCH_AGENT_ID = oldAgentId;
});

const profile: WatchProfile = {
  id: randomUUID(), name: 'Наблюдатель', instructions: 'Особенно важен вызов специалиста.',
  version: 1, instructionVersion: 1,
};
const generation = 'a'.repeat(64);

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
  assert.doesNotThrow(() => watchEventSchema.parse({ ...event, reason: 'mention', excerpts: ['Вопрос '.repeat(110)] }));
  assert.throws(() => watchEventSchema.parse({ ...event, reason: 'chat-update', excerpts: ['Вопрос '.repeat(110)] }));
});

test('stale changes and an unpaired Telegram make no model call', async () => {
  let calls = 0;
  const deps = {
    isTelegramReady: async () => { calls++; return false; },
    loadProfile: async () => profile,
    isConnectionCurrent: async () => true,
    isOutboxReady: () => true,
    reserve: async () => { calls++; return 'reserved' as const; },
    generate: async () => { calls++; return { text: '{}', usage: { inputTokens: 1, outputTokens: 1 } }; },
    settle: async () => { calls++; },
    enqueue: async () => { calls++; return true; },
    deliver: async () => { calls++; return 'delivered' as const; },
  };
  assert.deepEqual(await processWatchEvent('workspace', event, generation, deps, new Date('2026-10-21T06:11:00Z')),
    { accepted: false, status: 'stale' });
  assert.equal(calls, 0);
  await assert.rejects(processWatchEvent('workspace', event, generation, deps, new Date('2026-10-21T06:01:00Z')),
    { code: 'WATCH_TELEGRAM_UNAVAILABLE' });
  assert.equal(calls, 1);
});

test('primary Orvo key cannot activate watch analysis without its own key', async () => {
  const previousPrimary = process.env.OPENAI_API_KEY;
  const previousWatch = process.env.ORVO_WATCH_OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'primary-only-test-key';
  delete process.env.ORVO_WATCH_OPENAI_API_KEY;
  let calls = 0;
  const deps = {
    isTelegramReady: async () => { calls++; return true; },
    loadProfile: async () => profile,
    isConnectionCurrent: async () => true,
    isOutboxReady: () => true,
    reserve: async () => { calls++; return 'reserved' as const; },
    generate: async () => { calls++; return { text: '{}', usage: { inputTokens: 1, outputTokens: 1 } }; },
    settle: async () => { calls++; },
    enqueue: async () => { calls++; return true; },
    deliver: async () => { calls++; return 'delivered' as const; },
  };
  try {
    await assert.rejects(processWatchEvent('workspace', event, generation, deps, new Date('2026-10-21T06:01:00Z')),
      { code: 'WATCH_MODEL_UNAVAILABLE' });
    assert.equal(calls, 0);
  } finally {
    if (previousPrimary === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousPrimary;
    if (previousWatch === undefined) delete process.env.ORVO_WATCH_OPENAI_API_KEY; else process.env.ORVO_WATCH_OPENAI_API_KEY = previousWatch;
  }
});

test('one fresh event can notify; duplicate never calls the model twice', async () => {
  const calls: string[] = [];
  const deps = {
    isTelegramReady: async () => true,
    loadProfile: async () => profile,
    isConnectionCurrent: async () => true,
    isOutboxReady: () => true,
    reserve: async (_workspaceId: string, _eventId: string, system: string) => {
      calls.push('reserve'); assert.match(system, /Особенно важен вызов специалиста/);
      return calls.filter(v => v === 'reserve').length === 1 ? 'reserved' as const : 'duplicate' as const;
    },
    generate: async (system: string) => { calls.push('model'); assert.equal(system, watchSystemInstructions(profile)); return {
      text: JSON.stringify({ priority: 'urgent', confidence: 0.96, summary: 'Нужен специалист для терминала', reason: 'Прямой вызов' }),
      usage: { inputTokens: 300, outputTokens: 70 },
    }; },
    settle: async () => { calls.push('settle'); },
    enqueue: async (_workspaceId: string, _eventId: string, message: string) => { calls.push('enqueue'); assert.match(message, /Нужен специалист/); return true; },
    deliver: async () => { calls.push('telegram'); return 'delivered' as const; },
  };
  const now = new Date('2026-10-21T06:01:00Z');
  assert.deepEqual(await processWatchEvent('workspace', event, generation, deps, now), { accepted: true, status: 'delivered' });
  assert.deepEqual(await processWatchEvent('workspace', event, generation, deps, now), { accepted: false, status: 'duplicate' });
  assert.deepEqual(calls, ['reserve', 'model', 'settle', 'enqueue', 'telegram', 'reserve']);
});

test('notification level suppresses unpinned routine tasks', () => {
  const action = { priority: 'action' as const, confidence: 0.9, summary: 'Проверить меню', reason: 'Просьба' };
  assert.equal(watchDecisionMatchesLevel(action, { ...event, level: 'urgent' }), false);
  assert.equal(watchDecisionMatchesLevel(action, { ...event, level: 'balanced', pinned: false }), false);
  assert.equal(watchDecisionMatchesLevel(action, { ...event, level: 'broad', pinned: false }), true);
});

test('explicit mention bypasses AI filtering and the notification level', async () => {
  const mention = { ...event, reason: 'mention' as const, level: 'urgent' as const,
    excerpts: ['Ирина: Как вернуть одно блюдо в меню?'], };
  const calls: string[] = [];
  const deps = {
    isTelegramReady: async () => true,
    loadProfile: async () => profile,
    isConnectionCurrent: async () => true,
    isOutboxReady: () => true,
    reserve: async () => { calls.push('reserve'); return 'reserved' as const; },
    claimMention: async () => { calls.push('claim'); return true; },
    generate: async () => { calls.push('model'); return { text: '{}', usage: { inputTokens: 0, outputTokens: 0 } }; },
    settle: async () => { calls.push('settle'); },
    enqueue: async (_workspace: string, _id: string, text: string) => {
      calls.push('enqueue');
      assert.match(text, /Вас упомянули/);
      assert.match(text, /Как вернуть одно блюдо/);
      return true;
    },
    deliver: async () => { calls.push('telegram'); return 'delivered' as const; },
  };
  const oldKey = process.env.ORVO_WATCH_OPENAI_API_KEY;
  delete process.env.ORVO_WATCH_OPENAI_API_KEY;
  try {
    assert.deepEqual(await processWatchEvent('workspace', mention, generation, deps, new Date('2026-10-21T06:01:00Z')),
      { accepted: true, status: 'delivered' });
    assert.deepEqual(calls, ['claim', 'enqueue', 'telegram']);
  } finally {
    if (oldKey === undefined) delete process.env.ORVO_WATCH_OPENAI_API_KEY;
    else process.env.ORVO_WATCH_OPENAI_API_KEY = oldKey;
  }
});

test('unknown model outcome retains claim and never sends Telegram', async () => {
  const calls: string[] = [];
  const deps = {
    isTelegramReady: async () => true,
    loadProfile: async () => profile,
    isConnectionCurrent: async () => true,
    isOutboxReady: () => true,
    reserve: async () => { calls.push('reserve'); return 'reserved' as const; },
    generate: async () => { calls.push('model'); throw new Error('Private provider response'); },
    settle: async () => { calls.push('settle'); },
    enqueue: async () => { calls.push('enqueue'); return true; },
    deliver: async () => { calls.push('telegram'); return 'delivered' as const; },
  };
  await assert.rejects(processWatchEvent('workspace', event, generation, deps, new Date('2026-10-21T06:01:00Z')),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'WATCH_MODEL_UNAVAILABLE');
      assert.doesNotMatch(String(error), /Private provider response/);
      return true;
    });
  assert.deepEqual(calls, ['reserve', 'model']);
});

test('missing profile blocks analysis before reservation or model call', async () => {
  let billed = false;
  const deps = {
    isTelegramReady: async () => true,
    loadProfile: async () => null,
    isConnectionCurrent: async () => true,
    isOutboxReady: () => true,
    reserve: async () => { billed = true; return 'reserved' as const; },
    generate: async () => { billed = true; return { text: '{}', usage: { inputTokens: 1, outputTokens: 1 } }; },
    settle: async () => {},
    enqueue: async () => true,
    deliver: async () => 'delivered' as const,
  };
  await assert.rejects(processWatchEvent('workspace', event, generation, deps, new Date('2026-10-21T06:01:00Z')),
    { code: 'WATCH_AGENT_UNAVAILABLE' });
  assert.equal(billed, false);
});

test('archived or edited profile after model response cannot enqueue an alert', async () => {
  for (const later of [null, { ...profile, version: 2, instructionVersion: 2, instructions: 'Новые критерии' }]) {
    let reads = 0;
    let enqueued = false;
    const deps = {
      isTelegramReady: async () => true,
      loadProfile: async () => ++reads === 1 ? profile : later,
      isConnectionCurrent: async () => true,
      isOutboxReady: () => true,
      reserve: async () => 'reserved' as const,
      generate: async () => ({
        text: JSON.stringify({ priority: 'urgent', confidence: 0.98, summary: 'Нужен специалист', reason: 'Вызов' }),
        usage: { inputTokens: 100, outputTokens: 40 },
      }),
      settle: async () => {},
      enqueue: async () => { enqueued = true; return true; },
      deliver: async () => 'delivered' as const,
    };
    assert.deepEqual(await processWatchEvent('workspace', event, generation, deps, new Date('2026-10-21T06:01:00Z')),
      { accepted: true, status: 'disabled' });
    assert.equal(enqueued, false);
  }
});

test('credential rotation during model analysis prevents an alert from being queued', async () => {
  let checks = 0;
  let enqueued = false;
  const deps = {
    isTelegramReady: async () => true,
    loadProfile: async () => profile,
    isConnectionCurrent: async () => ++checks === 1,
    isOutboxReady: () => true,
    reserve: async () => 'reserved' as const,
    generate: async () => ({
      text: JSON.stringify({ priority: 'urgent', confidence: 0.99, summary: 'Нужен специалист', reason: 'Вызов' }),
      usage: { inputTokens: 100, outputTokens: 30 },
    }),
    settle: async () => {},
    enqueue: async () => { enqueued = true; return true; },
    deliver: async () => 'delivered' as const,
  };
  assert.deepEqual(await processWatchEvent('workspace', event, generation, deps, new Date('2026-10-21T06:01:00Z')),
    { accepted: true, status: 'disabled' });
  assert.equal(checks, 2);
  assert.equal(enqueued, false);
});

test('profile loader binds by exact ID and rejects missing, archived and overlong instructions', async () => {
  const { getWorkspace } = await import('../src/server/domain');
  const { getDatabase, query } = await import('../src/server/db');
  const workspace = await getWorkspace();
  const agentId = randomUUID();
  process.env.ORVO_WATCH_AGENT_ID = agentId;
  try {
    assert.equal(await loadWatchProfile(workspace.id), null);
    const data = { name: 'Наблюдатель', instructions: 'Сигнал о вызове специалиста', instructionVersion: 1 };
    await query('INSERT INTO agents(id,workspace_id,role_key,data) VALUES($1,$2,$3,$4)',
      [agentId, workspace.id, `custom-${agentId}`, JSON.stringify(data)]);
    assert.deepEqual(await loadWatchProfile(workspace.id), { id: agentId, name: data.name,
      instructions: data.instructions, version: 1, instructionVersion: 1 });
    assert.equal(await loadWatchProfile('another-workspace'), null);
    await query('UPDATE agents SET archived=true WHERE id=$1', [agentId]);
    assert.equal(await loadWatchProfile(workspace.id), null);
    await query('UPDATE agents SET archived=false,data=$2 WHERE id=$1',
      [agentId, JSON.stringify({ ...data, instructions: 'x'.repeat(4001) })]);
    assert.equal(await loadWatchProfile(workspace.id), null);
  } finally {
    const database = await getDatabase();
    if (database.kind === 'pglite') await database.db.close();
  }
});
