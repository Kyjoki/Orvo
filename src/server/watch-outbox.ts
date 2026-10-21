import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { query, transaction } from './db';
import { sendTelegramAlert } from './telegram';
import { watchPeriod } from './watch-budget';
import { loadWatchProfile } from './watch-profile';
import { DomainError } from '../shared/types';
import { watchConnectionGeneration, watchConnectionGenerationIsCurrent } from './watch-connection-generation';

const MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 30;
const MAX_BATCH = 4;
const MAX_ALERT_BYTES = 3500;

type AlertRow = {
  workspace_id: string; event_id: string; agent_id: string; agent_version: number; connection_generation: string; ciphertext: string; nonce: string;
  auth_tag: string; attempts: number; lease_token: string; expires_at: Date;
};

export function watchOutboxConfigured() {
  return Boolean(process.env.ORVO_RUNTIME_SECRET && process.env.ORVO_RUNTIME_SECRET.length >= 32);
}

function encryptionKey() {
  const secret = process.env.ORVO_RUNTIME_SECRET;
  if (!secret || secret.length < 32) throw new DomainError('WATCH_OUTBOX_UNAVAILABLE', 'Защищённая очередь уведомлений не настроена.', 503);
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('orvo-watch-alerts-v1'), Buffer.from('telegram-outbox'), 32));
}

function associatedData(workspaceId: string, eventId: string) {
  return Buffer.from(`orvo-watch-alert-v1\0${workspaceId}\0${eventId}`, 'utf8');
}

export function encryptWatchAlert(workspaceId: string, eventId: string, message: string) {
  const plain = Buffer.from(message, 'utf8');
  if (!plain.length || plain.length > MAX_ALERT_BYTES) throw new DomainError('INVALID_WATCH_ALERT', 'Некорректное уведомление.', 400);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  cipher.setAAD(associatedData(workspaceId, eventId));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

export function decryptWatchAlert(workspaceId: string, eventId: string, encrypted: { ciphertext: Uint8Array | string; nonce: Uint8Array | string; auth_tag: Uint8Array | string }) {
  const decode = (value: Uint8Array | string) => typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value);
  const nonce = decode(encrypted.nonce);
  const tag = decode(encrypted.auth_tag);
  const ciphertext = decode(encrypted.ciphertext);
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length < 1 || ciphertext.length > MAX_ALERT_BYTES) throw new Error('Invalid encrypted alert.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce);
  decipher.setAAD(associatedData(workspaceId, eventId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export async function enqueueWatchAlert(workspaceId: string, eventId: string, message: string, expiresAt: Date,
  agent: { id: string; version: number }, connectionGeneration: string) {
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return false;
  if (!agent.id || !Number.isSafeInteger(agent.version) || agent.version < 1) return false;
  const encrypted = encryptWatchAlert(workspaceId, eventId, message);
  return transaction(async (db) => {
    // A credential replacement waits for this shared row lock before it can invalidate the queue.
    const connection = (await db.query<{ token_hash: string }>(
      'SELECT token_hash FROM watch_connections WHERE workspace_id=$1 FOR SHARE', [workspaceId],
    )).rows[0];
    if (!connection || watchConnectionGeneration(connection.token_hash) !== connectionGeneration) return false;
    const inserted = await db.query(`INSERT INTO watch_alert_outbox(workspace_id,event_id,agent_id,agent_version,connection_generation,ciphertext,nonce,auth_tag,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING event_id`,
    [workspaceId, eventId, agent.id, agent.version, connectionGeneration, encrypted.ciphertext.toString('base64'), encrypted.nonce.toString('base64'), encrypted.authTag.toString('base64'), expiresAt]);
    return inserted.rows.length > 0;
  });
}

export async function expireWatchAlerts() {
  const result = await query(`UPDATE watch_alert_outbox SET state='expired',ciphertext=NULL,nonce=NULL,auth_tag=NULL,
    lease_token=NULL,lease_until=NULL WHERE state IN ('pending','leased') AND expires_at<=now() RETURNING event_id`);
  return result.rows.length;
}

/** Revoking the extension credential also discards unsent watch notifications. */
export async function cancelWatchAlerts(workspaceId: string) {
  const result = await query(`UPDATE watch_alert_outbox SET state='expired',ciphertext=NULL,nonce=NULL,auth_tag=NULL,
    lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND state IN ('pending','leased') RETURNING event_id`, [workspaceId]);
  return result.rows.length;
}

async function discardPendingWatchAlerts() {
  const result = await query(`UPDATE watch_alert_outbox SET state='expired',ciphertext=NULL,nonce=NULL,auth_tag=NULL,
    lease_token=NULL,lease_until=NULL WHERE state IN ('pending','leased') RETURNING event_id`);
  return result.rows.length;
}

async function claimWatchAlert(workspaceId?: string, eventId?: string): Promise<AlertRow | null> {
  return transaction(async (db) => {
    const row = (await db.query<AlertRow>(`SELECT * FROM watch_alert_outbox
      WHERE ($1::text IS NULL OR workspace_id=$1) AND ($2::text IS NULL OR event_id=$2)
      AND attempts<$3 AND expires_at>now()
      AND ((state='pending' AND next_attempt_at<=now()) OR (state='leased' AND lease_until<now()))
      ORDER BY next_attempt_at,created_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [workspaceId ?? null, eventId ?? null, MAX_ATTEMPTS])).rows[0];
    if (!row) return null;
    const token = randomUUID();
    return (await db.query<AlertRow>(`UPDATE watch_alert_outbox SET state='leased',lease_token=$3,
      lease_until=now()+($4::integer*interval '1 second'),attempts=attempts+1
      WHERE workspace_id=$1 AND event_id=$2 RETURNING *`,
    [row.workspace_id, row.event_id, token, LEASE_SECONDS])).rows[0] ?? null;
  });
}

async function markWatchAlertDelivered(row: AlertRow) {
  const result = await query(`UPDATE watch_alert_outbox SET state='delivered',sent_at=now(),
    ciphertext=NULL,nonce=NULL,auth_tag=NULL,lease_token=NULL,lease_until=NULL
    WHERE workspace_id=$1 AND event_id=$2 AND state='leased' AND lease_token=$3 AND lease_until>now()
    RETURNING event_id`, [row.workspace_id, row.event_id, row.lease_token]);
  return result.rows.length === 1;
}

async function markWatchAlertFailure(row: AlertRow, terminal: boolean) {
  const dead = terminal || row.attempts >= MAX_ATTEMPTS;
  const backoffSeconds = row.attempts === 1 ? 30 : 120;
  const result = await query(`UPDATE watch_alert_outbox SET state=CASE WHEN $4::boolean OR expires_at<=now() THEN
      CASE WHEN expires_at<=now() THEN 'expired' ELSE 'dead' END ELSE 'pending' END,
    ciphertext=CASE WHEN $4::boolean OR expires_at<=now() THEN NULL ELSE ciphertext END,
    nonce=CASE WHEN $4::boolean OR expires_at<=now() THEN NULL ELSE nonce END,
    auth_tag=CASE WHEN $4::boolean OR expires_at<=now() THEN NULL ELSE auth_tag END,
    next_attempt_at=now()+($5::integer*interval '1 second'),lease_token=NULL,lease_until=NULL
    WHERE workspace_id=$1 AND event_id=$2 AND state='leased' AND lease_token=$3
    RETURNING state`, [row.workspace_id, row.event_id, row.lease_token, dead, backoffSeconds]);
  return result.rows[0]?.state as 'pending' | 'expired' | 'dead' | undefined;
}

async function markWatchAlertExpired(row: AlertRow) {
  await query(`UPDATE watch_alert_outbox SET state='expired',ciphertext=NULL,nonce=NULL,auth_tag=NULL,
    lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND event_id=$2 AND state='leased' AND lease_token=$3`,
  [row.workspace_id, row.event_id, row.lease_token]);
}

export type WatchDeliveryStatus = 'delivered' | 'queued' | 'failed';

/** A lease bounds concurrency; after an ambiguous Bot API result duplicate alerts are possible. */
export async function deliverWatchAlert(workspaceId?: string, eventId?: string,
  sender: (workspaceId: string, message: string) => Promise<void> = sendTelegramAlert): Promise<WatchDeliveryStatus | 'none'> {
  if (process.env.ORVO_WATCH_EVENTS_ENABLED !== '1') { await discardPendingWatchAlerts(); return 'none'; }
  await expireWatchAlerts();
  const row = await claimWatchAlert(workspaceId, eventId);
  if (!row) return 'none';
  let message: string;
  try { message = decryptWatchAlert(row.workspace_id, row.event_id, row); }
  catch { await markWatchAlertFailure(row, true); return 'failed'; }
  // Recheck the switch and expiry immediately before the external side effect.
  if (process.env.ORVO_WATCH_EVENTS_ENABLED !== '1' || new Date(row.expires_at).getTime() <= Date.now()) {
    await markWatchAlertExpired(row);
    return 'failed';
  }
  // Only the exact profile revision that produced the decision may send it.
  const profile = await loadWatchProfile(row.workspace_id);
  if (!profile || profile.id !== row.agent_id || profile.version !== row.agent_version) {
    await markWatchAlertExpired(row);
    return 'failed';
  }
  if (!(await watchConnectionGenerationIsCurrent(row.workspace_id, row.connection_generation))) {
    await markWatchAlertExpired(row);
    return 'failed';
  }
  const current = (await query<{ state: string; lease_token: string | null }>(
    'SELECT state,lease_token FROM watch_alert_outbox WHERE workspace_id=$1 AND event_id=$2',
    [row.workspace_id, row.event_id],
  )).rows[0];
  if (current?.state !== 'leased' || current.lease_token !== row.lease_token) return 'none';
  try {
    await sender(row.workspace_id, message);
    return await markWatchAlertDelivered(row) ? 'delivered' : 'queued';
  } catch {
    const state = await markWatchAlertFailure(row, false);
    return state === 'pending' ? 'queued' : 'failed';
  }
}

export async function drainWatchAlertOutbox(limit = MAX_BATCH,
  sender: (workspaceId: string, message: string) => Promise<void> = sendTelegramAlert) {
  const expired = await expireWatchAlerts();
  if (process.env.ORVO_WATCH_EVENTS_ENABLED !== '1') return { delivered: 0, queued: 0, failed: 0, expired: expired + await discardPendingWatchAlerts() };
  const bounded = Math.max(1, Math.min(MAX_BATCH, Math.trunc(limit)));
  const totals = { delivered: 0, queued: 0, failed: 0, expired };
  for (let i = 0; i < bounded; i++) {
    const result = await deliverWatchAlert(undefined, undefined, sender);
    if (result === 'none') break;
    totals[result]++;
  }
  return totals;
}

export async function watchAlertCounts(workspaceId: string) {
  const rows = (await query<{ state: string; count: number }>(`SELECT o.state,count(*)::int AS count
    FROM watch_alert_outbox o JOIN watch_analysis_events e
      ON e.workspace_id=o.workspace_id AND e.event_id=o.event_id
    WHERE o.workspace_id=$1 AND e.period=$2 GROUP BY o.state`, [workspaceId, watchPeriod(new Date())])).rows;
  const counts = { pending: 0, delivered: 0, expired: 0, dead: 0 };
  for (const row of rows) {
    const state = row.state === 'leased' ? 'pending' : row.state;
    if (state in counts) counts[state as keyof typeof counts] += Number(row.count);
  }
  return counts;
}
