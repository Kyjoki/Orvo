import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

process.env.ORVO_TEST_MODE = '1';
delete process.env.DATABASE_URL;
process.env.ORVO_TEST_DB_NAME = `watch-outbox-${process.pid}-${randomUUID().slice(0, 8)}`;
process.env.ORVO_WORKSPACE_ID = `watch-outbox-${process.pid}`;
process.env.ORVO_RUNTIME_SECRET = 'watch-outbox-secret-for-unit-tests-000000000000';
process.env.ORVO_WATCH_EVENTS_ENABLED = '1';

const { getWorkspace } = await import('../src/server/domain');
const { query, getDatabase } = await import('../src/server/db');
const { reserveWatchBudget } = await import('../src/server/watch-budget');
const { encryptWatchAlert, decryptWatchAlert, enqueueWatchAlert, deliverWatchAlert,
  expireWatchAlerts, watchAlertCounts } = await import('../src/server/watch-outbox');
const { createWatchConnection, revokeWatchConnection } = await import('../src/server/watch-connection');
const workspace = await getWorkspace();
const id = () => randomBytes(32).toString('hex');
const future = () => new Date(Date.now() + 15 * 60_000);
async function reserve(eventId: string) {
  assert.equal(await reserveWatchBudget(workspace.id, eventId, 'rule', 'synthetic'), 'reserved');
}
after(async () => { const db = await getDatabase(); if (db.kind === 'pglite') await db.db.close(); });

test('AES-GCM binds the alert to its event and detects tampering', () => {
  const eventId = id();
  const text = 'Тест: нужен специалист';
  const encrypted = encryptWatchAlert(workspace.id, eventId, text);
  assert.equal(decryptWatchAlert(workspace.id, eventId, { ...encrypted, auth_tag: encrypted.authTag }), text);
  assert.throws(() => decryptWatchAlert(workspace.id, id(), { ...encrypted, auth_tag: encrypted.authTag }));
  const changed = Buffer.from(encrypted.ciphertext); changed[0] ^= 1;
  assert.throws(() => decryptWatchAlert(workspace.id, eventId, { ...encrypted, ciphertext: changed, auth_tag: encrypted.authTag }));
});

test('delivered alert is encrypted in DB then promptly purged; duplicate cannot resend', async () => {
  const eventId = id(); await reserve(eventId);
  assert.equal(await enqueueWatchAlert(workspace.id, eventId, 'Synthetic terminal problem', future()), true);
  assert.equal(await enqueueWatchAlert(workspace.id, eventId, 'Synthetic terminal problem', future()), false);
  const before = (await query<{ ciphertext: string; state: string }>(
    'SELECT ciphertext,state FROM watch_alert_outbox WHERE workspace_id=$1 AND event_id=$2', [workspace.id, eventId],
  )).rows[0];
  assert.equal(before.state, 'pending');
  assert.equal(before.ciphertext.includes('Synthetic terminal problem'), false);
  const delivered: string[] = [];
  assert.equal(await deliverWatchAlert(workspace.id, eventId, async (_workspace, text) => { delivered.push(text); }), 'delivered');
  assert.deepEqual(delivered, ['Synthetic terminal problem']);
  assert.equal(await deliverWatchAlert(workspace.id, eventId, async () => { throw new Error('duplicate'); }), 'none');
  const afterDelivery = (await query<{ ciphertext: string | null; state: string }>(
    'SELECT ciphertext,state FROM watch_alert_outbox WHERE workspace_id=$1 AND event_id=$2', [workspace.id, eventId],
  )).rows[0];
  assert.equal(afterDelivery.state, 'delivered');
  assert.equal(afterDelivery.ciphertext, null);
});

test('ambiguous Telegram result is retried with lease; three failures become dead', async () => {
  const eventId = id(); await reserve(eventId);
  await enqueueWatchAlert(workspace.id, eventId, 'Synthetic urgent alert', future());
  let sends = 0;
  const fails = async () => { sends++; throw new Error('Synthetic timeout'); };
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await query("UPDATE watch_alert_outbox SET next_attempt_at=now()-interval '1 second' WHERE workspace_id=$1 AND event_id=$2", [workspace.id, eventId]);
    assert.equal(await deliverWatchAlert(workspace.id, eventId, fails), attempt === 3 ? 'failed' : 'queued');
  }
  assert.equal(sends, 3);
  const row = (await query<{ state: string; attempts: number; ciphertext: string | null }>(
    'SELECT state,attempts,ciphertext FROM watch_alert_outbox WHERE workspace_id=$1 AND event_id=$2', [workspace.id, eventId],
  )).rows[0];
  assert.equal(row.state, 'dead');
  assert.equal(row.attempts, 3);
  assert.equal(row.ciphertext, null);
  const counts = await watchAlertCounts(workspace.id);
  assert.ok(counts.dead >= 1);
});

test('expired alerts and alerts encrypted under an old runtime secret are never sent', async () => {
  const expiredId = id(); await reserve(expiredId);
  await enqueueWatchAlert(workspace.id, expiredId, 'Synthetic old alert', future());
  await query("UPDATE watch_alert_outbox SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND event_id=$2", [workspace.id, expiredId]);
  assert.ok(await expireWatchAlerts() >= 1);
  assert.equal(await deliverWatchAlert(workspace.id, expiredId, async () => { throw new Error('must not send'); }), 'none');
  const expired = (await query<{ state: string; ciphertext: string | null }>(
    'SELECT state,ciphertext FROM watch_alert_outbox WHERE workspace_id=$1 AND event_id=$2', [workspace.id, expiredId],
  )).rows[0];
  assert.equal(expired.state, 'expired');
  assert.equal(expired.ciphertext, null);

  const rotatedId = id(); await reserve(rotatedId);
  await enqueueWatchAlert(workspace.id, rotatedId, 'Synthetic encrypted alert', future());
  process.env.ORVO_RUNTIME_SECRET = 'new-restore-secret-for-unit-tests-000000000000000';
  try {
    assert.equal(await deliverWatchAlert(workspace.id, rotatedId, async () => { throw new Error('must not send'); }), 'failed');
  } finally { process.env.ORVO_RUNTIME_SECRET = 'watch-outbox-secret-for-unit-tests-000000000000'; }
  const rotated = (await query<{ state: string; ciphertext: string | null }>(
    'SELECT state,ciphertext FROM watch_alert_outbox WHERE workspace_id=$1 AND event_id=$2', [workspace.id, rotatedId],
  )).rows[0];
  assert.equal(rotated.state, 'dead');
  assert.equal(rotated.ciphertext, null);
});

test('server kill switch purges queued alerts without sending them later', async () => {
  const eventId = id(); await reserve(eventId);
  await enqueueWatchAlert(workspace.id, eventId, 'Synthetic paused alert', future());
  process.env.ORVO_WATCH_EVENTS_ENABLED = '0';
  try {
    assert.equal(await deliverWatchAlert(workspace.id, eventId, async () => { throw new Error('must not send'); }), 'none');
  } finally { process.env.ORVO_WATCH_EVENTS_ENABLED = '1'; }
  const row = (await query<{ state: string; ciphertext: string | null }>(
    'SELECT state,ciphertext FROM watch_alert_outbox WHERE workspace_id=$1 AND event_id=$2', [workspace.id, eventId],
  )).rows[0];
  assert.equal(row.state, 'expired');
  assert.equal(row.ciphertext, null);
  assert.equal(await deliverWatchAlert(workspace.id, eventId, async () => { throw new Error('must not resend'); }), 'none');
});

test('revoking a watch connection cancels its queued alert', async () => {
  const eventId = id(); await reserve(eventId);
  await createWatchConnection(workspace.id);
  await enqueueWatchAlert(workspace.id, eventId, 'Synthetic private alert', future());
  assert.equal((await revokeWatchConnection(workspace.id)).connected, false);
  assert.equal(await deliverWatchAlert(workspace.id, eventId, async () => { throw new Error('must not send'); }), 'none');
  const row = (await query<{ state: string; ciphertext: string | null }>(
    'SELECT state,ciphertext FROM watch_alert_outbox WHERE workspace_id=$1 AND event_id=$2', [workspace.id, eventId],
  )).rows[0];
  assert.equal(row.state, 'expired');
  assert.equal(row.ciphertext, null);
});

test('parallel workers lease the same alert only once', async () => {
  const eventId = id(); await reserve(eventId);
  await enqueueWatchAlert(workspace.id, eventId, 'Synthetic parallel alert', future());
  let sends = 0;
  const sender = async () => { sends++; await new Promise(resolve => setTimeout(resolve, 20)); };
  const outcomes = await Promise.all([
    deliverWatchAlert(workspace.id, eventId, sender),
    deliverWatchAlert(workspace.id, eventId, sender),
  ]);
  assert.deepEqual(outcomes.sort(), ['delivered', 'none']);
  assert.equal(sends, 1);
});
