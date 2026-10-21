import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from './db';
import { DomainError } from '../shared/types';

const tokenPattern = /^orvo_watch_[A-Za-z0-9_-]{43}$/;

export function hashWatchToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function newWatchToken() {
  return `orvo_watch_${randomBytes(32).toString('base64url')}`;
}

export async function watchConnectionStatus(workspaceId: string) {
  const row = (await query<{created_at: Date}>(
    'SELECT created_at FROM watch_connections WHERE workspace_id=$1', [workspaceId]
  )).rows[0];
  return { connected: Boolean(row), createdAt: row?.created_at ?? null };
}

export async function createWatchConnection(workspaceId: string) {
  const token = newWatchToken();
  await query(`INSERT INTO watch_connections(workspace_id,token_hash)
    VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET
    token_hash=EXCLUDED.token_hash,created_at=now()`, [workspaceId, hashWatchToken(token)]);
  return { ...(await watchConnectionStatus(workspaceId)), token };
}

export async function revokeWatchConnection(workspaceId: string) {
  await query('DELETE FROM watch_connections WHERE workspace_id=$1', [workspaceId]);
  return watchConnectionStatus(workspaceId);
}

export async function requireWatchConnection(workspaceId: string, authorization: string | null) {
  const match = /^Bearer (\S+)$/.exec(authorization ?? '');
  const token = match?.[1] ?? '';
  if (!tokenPattern.test(token)) throw new DomainError('WATCH_UNAUTHORIZED', 'Расширение не привязано к Orvo.', 401);
  const row = (await query<{token_hash: string}>(
    'SELECT token_hash FROM watch_connections WHERE workspace_id=$1', [workspaceId]
  )).rows[0];
  const actual = Buffer.from(hashWatchToken(token), 'hex');
  const expected = Buffer.from(row?.token_hash ?? '', 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new DomainError('WATCH_UNAUTHORIZED', 'Расширение не привязано к Orvo.', 401);
  }
}
