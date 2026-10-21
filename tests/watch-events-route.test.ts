import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

process.env.ORVO_TEST_MODE = '1';
delete process.env.DATABASE_URL;
process.env.ORVO_TEST_DB_NAME = `watch-events-route-${process.pid}-${randomUUID().slice(0, 8)}`;
process.env.ORVO_WORKSPACE_ID = `watch-events-route-${process.pid}`;
process.env.BETTER_AUTH_SECRET = 'watch-route-test-secret-000000000000000000';
delete process.env.ORVO_WATCH_EVENTS_ENABLED;

const { getWorkspace } = await import('../src/server/domain');
const { createWatchConnection } = await import('../src/server/watch-connection');
const { getDatabase, query } = await import('../src/server/db');
const { POST } = await import('../src/app/api/watch/events/route');
const workspace = await getWorkspace();
const { token } = await createWatchConnection(workspace.id);

after(async () => {
  const db = await getDatabase();
  if (db.kind === 'pglite') await db.db.close();
});

test('disabled ingest authenticates but never reads or stores chat text', async () => {
  const request = new Request('https://orvo-office.vercel.app/api/watch/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: `chrome-extension://${'a'.repeat(32)}`,
      'Content-Type': 'application/json',
    },
    body: '{invalid JSON that must not be read',
  });
  const response = await POST(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: false, status: 'disabled' });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const row = (await query<{ count: number }>(
    'SELECT count(*)::int AS count FROM watch_analysis_events WHERE workspace_id=$1', [workspace.id],
  )).rows[0];
  assert.equal(row.count, 0);
});

test('cross-site origin and invalid bearer fail before payload processing', async () => {
  const badOrigin = await POST(new Request('https://orvo-office.vercel.app/api/watch/events', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://whatsapp.ailillu.kz' }, body: '{invalid',
  }));
  assert.equal(badOrigin.status, 403);
  const badBearer = await POST(new Request('https://orvo-office.vercel.app/api/watch/events', {
    method: 'POST', headers: { Authorization: 'Bearer invalid' }, body: '{invalid',
  }));
  assert.equal(badBearer.status, 401);
});

test('enabled ingest reserves once, classifies synthetic text and sends one encrypted-outbox alert', async () => {
  const old = {
    flag: process.env.ORVO_WATCH_EVENTS_ENABLED,
    key: process.env.OPENAI_API_KEY,
    bot: process.env.TELEGRAM_BOT_TOKEN,
    runtime: process.env.ORVO_RUNTIME_SECRET,
    fetch: globalThis.fetch,
  };
  const botToken = 'synthetic-bot-token';
  process.env.ORVO_WATCH_EVENTS_ENABLED = '1';
  process.env.OPENAI_API_KEY = 'synthetic-openai-key';
  process.env.TELEGRAM_BOT_TOKEN = botToken;
  process.env.ORVO_RUNTIME_SECRET = 'synthetic-runtime-secret-000000000000000000';
  await query(`INSERT INTO telegram_connections(workspace_id,chat_id,bot_username,token_hash,last_test_at)
    VALUES($1,$2,$3,$4,now())`, [workspace.id, '1234567', 'SyntheticBot', createHash('sha256').update(botToken).digest('hex')]);
  let modelCalls = 0;
  let telegramCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.openai.com/v1/responses') {
      modelCalls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'gpt-6-luna');
      assert.equal(body.store, false);
      assert.deepEqual(body.reasoning, { effort: 'none' });
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify({ priority: 'urgent', confidence: 0.98,
          summary: 'Нужен специалист для терминала', reason: 'Прямой вызов' }) }] }],
      usage: { input_tokens: 200, output_tokens: 60 } });
    }
    if (url === `https://api.telegram.org/bot${botToken}/sendMessage`) {
      telegramCalls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.chat_id, '1234567');
      assert.match(body.text, /Нужен специалист/);
      return Response.json({ ok: true, result: { message_id: 7 } });
    }
    throw new Error('Unexpected network destination');
  };
  try {
    const eventId = randomBytes(32).toString('hex');
    const payload = { eventId, chatTitle: 'Синтетический клиент', pinned: true,
      excerpts: ['Терминал не работает. Вызовите специалиста.'], reason: 'urgent',
      observedAt: new Date().toISOString(), level: 'balanced' };
    const send = () => POST(new Request('https://orvo-office.vercel.app/api/watch/events', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: `chrome-extension://${'a'.repeat(32)}`,
        'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }));
    const first = await send();
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { accepted: true, status: 'delivered' });
    const second = await send();
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { accepted: false, status: 'duplicate' });
    assert.equal(modelCalls, 1);
    assert.equal(telegramCalls, 1);
    const outbox = (await query<{ state: string; ciphertext: string | null }>(
      'SELECT state,ciphertext FROM watch_alert_outbox WHERE workspace_id=$1 AND event_id=$2', [workspace.id, eventId],
    )).rows[0];
    assert.equal(outbox.state, 'delivered');
    assert.equal(outbox.ciphertext, null);
  } finally {
    globalThis.fetch = old.fetch;
    for (const [name, value] of [
      ['ORVO_WATCH_EVENTS_ENABLED', old.flag], ['OPENAI_API_KEY', old.key],
      ['TELEGRAM_BOT_TOKEN', old.bot], ['ORVO_RUNTIME_SECRET', old.runtime],
    ] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
