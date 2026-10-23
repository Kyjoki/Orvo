import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query, transaction } from './db';
import { redactWatchText } from './watch-triage';
import type { WatchEvent, WatchEventStatus } from './watch-events';
import { DomainError } from '../shared/types';

export const WATCH_REVIEW_DAY = '2026-10-23';
const RETENTION_DAYS = 7;
const PAGE_SIZE = 100;
const MAX_PAYLOAD_BYTES = 6500;

type CandidateContent = { chatTitle: string; excerpts: string[]; pinned: boolean;
  level: WatchEvent['level']; explanation?: string };
type CandidateRow = { event_id: string; observed_at: Date; reason: WatchEvent['reason']; status: string;
  ciphertext: string; nonce: string; auth_tag: string; label: 'important' | 'noise' | null };

export function watchReviewDay(date: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Qyzylorda', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function watchReviewActive(now = new Date()) { return watchReviewDay(now) === WATCH_REVIEW_DAY; }

function key() {
  const secret = process.env.ORVO_RUNTIME_SECRET;
  if (!secret || secret.length < 32) throw new DomainError('WATCH_REVIEW_UNAVAILABLE', 'Защищённый журнал не настроен.', 503);
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('orvo-watch-review-v1'), Buffer.from('candidate-journal'), 32));
}

function aad(workspaceId: string, eventId: string) { return Buffer.from(`orvo-watch-review-v1\0${workspaceId}\0${eventId}`); }

function encrypt(workspaceId: string, eventId: string, value: CandidateContent) {
  const plain = Buffer.from(JSON.stringify(value));
  if (plain.length > MAX_PAYLOAD_BYTES) throw new DomainError('WATCH_REVIEW_TOO_LARGE', 'Кандидат слишком длинный.', 400);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  cipher.setAAD(aad(workspaceId, eventId));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

function decrypt(workspaceId: string, row: CandidateRow): CandidateContent {
  const ciphertext = Buffer.from(row.ciphertext, 'base64');
  const nonce = Buffer.from(row.nonce, 'base64');
  const tag = Buffer.from(row.auth_tag, 'base64');
  if (!ciphertext.length || ciphertext.length > MAX_PAYLOAD_BYTES || nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid review payload.');
  const decipher = createDecipheriv('aes-256-gcm', key(), nonce);
  decipher.setAAD(aad(workspaceId, row.event_id));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as CandidateContent;
}

async function purgeExpired(workspaceId: string, now: Date) {
  await query('DELETE FROM watch_candidate_reviews WHERE workspace_id=$1 AND expires_at<=$2', [workspaceId, now]);
}

/** Only extension-selected, fresh candidates received on the requested local day are recorded. */
export async function recordWatchCandidate(workspaceId: string, event: WatchEvent, now = new Date()) {
  if (!watchReviewActive(now)) return false;
  const age = now.getTime() - new Date(event.observedAt).getTime();
  if (age > 10 * 60_000 || age < -60_000) return false;
  const content: CandidateContent = {
    chatTitle: redactWatchText(event.chatTitle).slice(0, 120),
    excerpts: event.excerpts.map((part) => redactWatchText(part).slice(0, event.reason === 'mention' ? 1200 : 500)),
    pinned: event.pinned, level: event.level,
  };
  const encrypted = encrypt(workspaceId, event.eventId, content);
  await purgeExpired(workspaceId, now);
  const result = await query(`INSERT INTO watch_candidate_reviews
    (workspace_id,event_id,capture_day,observed_at,reason,ciphertext,nonce,auth_tag,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING event_id`,
  [workspaceId, event.eventId, WATCH_REVIEW_DAY, event.observedAt, event.reason,
    encrypted.ciphertext, encrypted.nonce, encrypted.authTag, new Date(now.getTime() + RETENTION_DAYS * 86400_000)]);
  return result.rows.length > 0;
}

export async function finishWatchCandidate(workspaceId: string, eventId: string, status: WatchEventStatus | 'error') {
  await query(`UPDATE watch_candidate_reviews SET status=$3
    WHERE workspace_id=$1 AND event_id=$2 AND status='processing'`, [workspaceId, eventId, status]);
}

export async function listWatchCandidates(workspaceId: string, offset: number, now = new Date()) {
  await purgeExpired(workspaceId, now);
  const rows = (await query<CandidateRow>(`SELECT r.event_id,r.observed_at,r.reason,
    CASE WHEN o.state='delivered' THEN 'delivered' WHEN o.state IN ('dead','expired') THEN 'failed'
      WHEN o.state IN ('pending','leased') THEN 'queued' ELSE r.status END AS status,
    r.ciphertext,r.nonce,r.auth_tag,r.label
    FROM watch_candidate_reviews r LEFT JOIN watch_alert_outbox o
      ON o.workspace_id=r.workspace_id AND o.event_id=r.event_id
    WHERE r.workspace_id=$1 AND r.capture_day=$2 AND r.expires_at>$3
    ORDER BY r.observed_at DESC,r.event_id DESC LIMIT $4 OFFSET $5`,
  [workspaceId, WATCH_REVIEW_DAY, now, PAGE_SIZE + 1, offset])).rows;
  return { items: rows.slice(0, PAGE_SIZE).map((row) => ({
    eventId: row.event_id, observedAt: new Date(row.observed_at).toISOString(), reason: row.reason,
    status: row.status, label: row.label, ...decrypt(workspaceId, row),
  })), hasMore: rows.length > PAGE_SIZE };
}

export const watchCandidateRatingInput = z.object({ eventId: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.enum(['important', 'noise']), explanation: z.string().trim().max(400).default('') }).strict();

export async function rateWatchCandidate(workspaceId: string, eventId: string,
  label: 'important' | 'noise', explanation = '') {
  return transaction(async (db) => {
    const row = (await db.query<CandidateRow>(`SELECT event_id,observed_at,reason,status,ciphertext,nonce,auth_tag,label
      FROM watch_candidate_reviews WHERE workspace_id=$1 AND event_id=$2 AND capture_day=$3
      AND expires_at>now() FOR UPDATE`, [workspaceId, eventId, WATCH_REVIEW_DAY])).rows[0];
    if (!row) throw new DomainError('WATCH_REVIEW_NOT_FOUND', 'Кандидат не найден или срок хранения истёк.', 404);
    const note = redactWatchText(explanation).slice(0, 400);
    const encrypted = encrypt(workspaceId, eventId, { ...decrypt(workspaceId, row), explanation: note });
    await db.query(`UPDATE watch_candidate_reviews SET label=$3,ciphertext=$4,nonce=$5,auth_tag=$6
      WHERE workspace_id=$1 AND event_id=$2`, [workspaceId, eventId, label,
      encrypted.ciphertext, encrypted.nonce, encrypted.authTag]);
    return { eventId, label, explanation: note };
  });
}

/** Reviewed candidates inform later model decisions without copying them into agent memory. */
export async function reviewedWatchExamples(workspaceId: string): Promise<{ label: 'important' | 'noise'; example: string; explanation: string }[]> {
  const rows = (await query<CandidateRow>(`SELECT event_id,observed_at,reason,status,ciphertext,nonce,auth_tag,label
    FROM watch_candidate_reviews WHERE workspace_id=$1 AND label IS NOT NULL AND expires_at>now()
    ORDER BY observed_at DESC LIMIT 200`, [workspaceId])).rows;
  return rows.map((row) => {
    const content = decrypt(workspaceId, row);
    return { label: row.label!, example: content.excerpts.at(-1)?.slice(0, 240) || '',
      explanation: content.explanation || '' };
  }).filter((item) => item.example);
}
