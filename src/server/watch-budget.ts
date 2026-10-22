import { transaction } from './db';
import { DomainError } from '../shared/types';

export const WATCH_MONTHLY_EVENT_LIMIT = 3000;
export const WATCH_MONTHLY_BUDGET_MICRO_USD = 5_000_000;
export const WATCH_ANALYSIS_MODEL = 'gpt-6-luna';
export const WATCH_MAX_OUTPUT_TOKENS = 300;

// Official standard API prices on 2026-10-21, in micro-USD per token.
const INPUT_MICRO_USD_PER_TOKEN = 0.1;
const OUTPUT_MICRO_USD_PER_TOKEN = 0.5;

export function watchActualMicroUsd(inputTokens: number, outputTokens: number) {
  if (![inputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Invalid token usage.');
  }
  return Math.ceil(inputTokens * INPUT_MICRO_USD_PER_TOKEN + outputTokens * OUTPUT_MICRO_USD_PER_TOKEN);
}

export function watchReservationMicroUsd(system: string, prompt: string) {
  // UTF-8 byte count is a conservative token bound for plain text BPE input.
  // Include ample overhead and a 20% price margin; fail closed if usage exceeds it.
  const inputBound = Buffer.byteLength(system + prompt, 'utf8') + 2048;
  return Math.ceil((inputBound * INPUT_MICRO_USD_PER_TOKEN +
    WATCH_MAX_OUTPUT_TOKENS * OUTPUT_MICRO_USD_PER_TOKEN) * 1.2);
}

const periodFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Qyzylorda', year: 'numeric', month: '2-digit',
});

export function watchPeriod(date: Date) {
  const parts = periodFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Watch accounting period is unavailable.');
  return `${year}-${month}`;
}

export type WatchBudgetResult = 'reserved' | 'duplicate' | 'limit-reached';

/** Claims a mention without an AI charge; the opaque row also anchors its encrypted outbox alert. */
export async function reserveWatchMention(workspaceId: string, eventId: string, date = new Date()) {
  if (!/^[a-f0-9]{64}$/.test(eventId)) {
    throw new DomainError('INVALID_WATCH_EVENT', 'Некорректное событие наблюдения.', 400);
  }
  return transaction(async (db) => {
    await db.query(`INSERT INTO watch_analysis_events(workspace_id,event_id,period,reserved_micro_usd,actual_micro_usd)
      VALUES($1,$2,$3,0,0) ON CONFLICT DO NOTHING`, [workspaceId, eventId, watchPeriod(date)]);
    const available = (await db.query<{ event_id: string }>(`SELECT e.event_id FROM watch_analysis_events e
      LEFT JOIN watch_alert_outbox o ON o.workspace_id=e.workspace_id AND o.event_id=e.event_id
      WHERE e.workspace_id=$1 AND e.event_id=$2 AND e.reserved_micro_usd=0 AND e.actual_micro_usd=0
        AND o.event_id IS NULL`, [workspaceId, eventId])).rows;
    return available.length === 1;
  });
}

/** Atomically claims an opaque event and reserves its maximum expected API cost. */
export async function reserveWatchBudget(
  workspaceId: string, eventId: string, system: string, prompt: string, date = new Date(),
): Promise<WatchBudgetResult> {
  const maxMicroUsd = watchReservationMicroUsd(system, prompt);
  if (!/^[a-f0-9]{64}$/.test(eventId) || !Number.isSafeInteger(maxMicroUsd) || maxMicroUsd < 1 ||
      maxMicroUsd > WATCH_MONTHLY_BUDGET_MICRO_USD) {
    throw new DomainError('INVALID_WATCH_EVENT', 'Некорректное событие наблюдения.', 400);
  }
  const period = watchPeriod(date);
  return transaction(async (db) => {
    const inserted = await db.query(`INSERT INTO watch_analysis_events(workspace_id,event_id,period,reserved_micro_usd)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`, [workspaceId, eventId, period, maxMicroUsd]);
    if (!inserted.rows.length) return 'duplicate';
    const usage = await db.query(`INSERT INTO watch_analysis_usage(workspace_id,period,accepted_count,committed_micro_usd)
      VALUES($1,$2,1,$3) ON CONFLICT(workspace_id,period) DO UPDATE SET
        accepted_count=watch_analysis_usage.accepted_count+1,
        committed_micro_usd=watch_analysis_usage.committed_micro_usd+$3
      WHERE watch_analysis_usage.accepted_count < $4
        AND watch_analysis_usage.committed_micro_usd+$3 <= $5
      RETURNING accepted_count`, [workspaceId, period, maxMicroUsd, WATCH_MONTHLY_EVENT_LIMIT, WATCH_MONTHLY_BUDGET_MICRO_USD]);
    if (!usage.rows.length) {
      await db.query('DELETE FROM watch_analysis_events WHERE workspace_id=$1 AND event_id=$2', [workspaceId, eventId]);
      return 'limit-reached';
    }
    return 'reserved';
  });
}

/** Reconcile a completed model call. Unknown or failed calls retain the full reservation. */
export async function settleWatchBudget(workspaceId: string, eventId: string, usage: {inputTokens: number; outputTokens: number}) {
  if (!/^[a-f0-9]{64}$/.test(eventId)) {
    throw new DomainError('INVALID_WATCH_EVENT', 'Некорректное событие наблюдения.', 400);
  }
  const actualMicroUsd = watchActualMicroUsd(usage.inputTokens, usage.outputTokens);
  return transaction(async (db) => {
    const row = (await db.query<{period: string; reserved_micro_usd: string; actual_micro_usd: string | null}>(
      'SELECT period,reserved_micro_usd,actual_micro_usd FROM watch_analysis_events WHERE workspace_id=$1 AND event_id=$2 FOR UPDATE',
      [workspaceId, eventId],
    )).rows[0];
    if (!row || row.actual_micro_usd !== null) return;
    const reserved = Number(row.reserved_micro_usd);
    if (actualMicroUsd > reserved) throw new DomainError('WATCH_BUDGET_MISMATCH', 'Анализ остановлен из-за расхождения расходов.', 503);
    await db.query('UPDATE watch_analysis_events SET actual_micro_usd=$3 WHERE workspace_id=$1 AND event_id=$2',
      [workspaceId, eventId, actualMicroUsd]);
    await db.query('UPDATE watch_analysis_usage SET committed_micro_usd=committed_micro_usd-$3 WHERE workspace_id=$1 AND period=$2',
      [workspaceId, row.period, reserved - actualMicroUsd]);
  });
}
