import { query } from './db';
import { WATCH_MONTHLY_BUDGET_MICRO_USD, WATCH_MONTHLY_EVENT_LIMIT, watchPeriod } from './watch-budget';

/** A conservative total: unknown provider outcomes keep their full reservation. */
export async function watchUsageStatus(workspaceId: string, now = new Date()) {
  const period = watchPeriod(now);
  const row = (await query<{ accepted_count: number; committed_micro_usd: string }>(
    'SELECT accepted_count,committed_micro_usd FROM watch_analysis_usage WHERE workspace_id=$1 AND period=$2',
    [workspaceId, period],
  )).rows[0];
  return {
    period,
    analyzed: Number(row?.accepted_count ?? 0),
    eventLimit: WATCH_MONTHLY_EVENT_LIMIT,
    accountedMicroUsd: Number(row?.committed_micro_usd ?? 0),
    budgetMicroUsd: WATCH_MONTHLY_BUDGET_MICRO_USD,
  };
}
