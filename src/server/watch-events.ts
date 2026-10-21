import { z } from 'zod';
import { generateOpenAI } from './openai';
import { reserveWatchBudget, settleWatchBudget, WATCH_ANALYSIS_MODEL, WATCH_MAX_OUTPUT_TOKENS, WATCH_MONTHLY_BUDGET_MICRO_USD, WATCH_MONTHLY_EVENT_LIMIT } from './watch-budget';
import { watchUsageStatus } from './watch-usage';
import { deliverWatchAlert, enqueueWatchAlert, watchOutboxConfigured, type WatchDeliveryStatus } from './watch-outbox';
import { formatWatchTelegram, parseWatchDecision, shouldNotifyWatch, WATCH_AGENT_INSTRUCTIONS, watchPrompt, type WatchCandidate, type WatchDecision } from './watch-triage';
import { telegramStatus } from './telegram';
import { DomainError } from '../shared/types';

export const watchEventSchema = z.object({
  // Generated randomly by the extension, and kept stable when retrying this event.
  eventId: z.string().regex(/^[a-f0-9]{64}$/),
  chatTitle: z.string().trim().min(1).max(120),
  pinned: z.boolean(),
  excerpts: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
  reason: z.enum(['urgent', 'pinned-request', 'chat-update']),
  observedAt: z.iso.datetime({ offset: true }),
  level: z.enum(['urgent', 'balanced', 'broad']),
}).strict();

export type WatchEvent = z.infer<typeof watchEventSchema>;
export type WatchEventStatus = 'delivered' | 'queued' | 'failed' | 'ignored' | 'duplicate' | 'limit-reached' | 'stale' | 'disabled';

export function watchEventsEnabled() {
  return process.env.ORVO_WATCH_EVENTS_ENABLED === '1';
}

export async function watchEventsReady(workspaceId: string) {
  if (!watchEventsEnabled() || !process.env.OPENAI_API_KEY || !watchOutboxConfigured()) return false;
  const usage = await watchUsageStatus(workspaceId);
  if (usage.analyzed >= WATCH_MONTHLY_EVENT_LIMIT || usage.accountedMicroUsd >= WATCH_MONTHLY_BUDGET_MICRO_USD) return false;
  const status = await telegramStatus(workspaceId);
  return status.paired && status.tested;
}

export function watchOriginAllowed(origin: string | null) {
  // Chrome does not guarantee an Origin header for extension service worker fetch.
  // Origin is defense in depth; the bearer credential is mandatory.
  return origin === null || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

export function watchDecisionMatchesLevel(decision: WatchDecision, event: WatchEvent) {
  if (!shouldNotifyWatch(decision)) return false;
  if (event.level === 'urgent') return decision.priority === 'urgent';
  if (event.level === 'balanced') return decision.priority === 'urgent' || (decision.priority === 'action' && event.pinned);
  return true;
}

type WatchServices = {
  isTelegramReady(workspaceId: string): Promise<boolean>;
  reserve(workspaceId: string, eventId: string, system: string, prompt: string): Promise<'reserved' | 'duplicate' | 'limit-reached'>;
  generate(system: string, prompt: string): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>;
  settle(workspaceId: string, eventId: string, usage: { inputTokens: number; outputTokens: number }): Promise<void>;
  isOutboxReady(): boolean;
  enqueue(workspaceId: string, eventId: string, message: string, expiresAt: Date): Promise<boolean>;
  deliver(workspaceId: string, eventId: string): Promise<WatchDeliveryStatus | 'none'>;
};

const services: WatchServices = {
  async isTelegramReady(workspaceId) {
    const status = await telegramStatus(workspaceId);
    return status.paired && status.tested;
  },
  reserve: reserveWatchBudget,
  generate: (system, prompt) => generateOpenAI({
    model: WATCH_ANALYSIS_MODEL,
    system,
    prompt,
    maxOutputTokens: WATCH_MAX_OUTPUT_TOKENS,
    reasoningEffort: 'none',
  }),
  settle: settleWatchBudget,
  isOutboxReady: watchOutboxConfigured,
  enqueue: enqueueWatchAlert,
  deliver: deliverWatchAlert,
};

/** No chat text is persisted; the event table contains only random identifiers and cost. */
export async function processWatchEvent(
  workspaceId: string,
  event: WatchEvent,
  deps: WatchServices = services,
  now = new Date(),
): Promise<{ accepted: boolean; status: WatchEventStatus }> {
  const age = now.getTime() - new Date(event.observedAt).getTime();
  if (age > 10 * 60_000 || age < -60_000) return { accepted: false, status: 'stale' };
  if (!watchEventsEnabled()) return { accepted: false, status: 'disabled' };
  if (!process.env.OPENAI_API_KEY) {
    throw new DomainError('WATCH_MODEL_UNAVAILABLE', 'Модель наблюдения не настроена.', 503);
  }
  if (!(await deps.isTelegramReady(workspaceId))) {
    throw new DomainError('WATCH_TELEGRAM_UNAVAILABLE', 'Проверенный Telegram-чат не привязан.', 503);
  }
  if (!deps.isOutboxReady()) {
    throw new DomainError('WATCH_OUTBOX_UNAVAILABLE', 'Защищённая очередь уведомлений не настроена.', 503);
  }
  const candidate: WatchCandidate = {
    chatTitle: event.chatTitle,
    pinned: event.pinned,
    excerpts: event.excerpts,
  };
  const prompt = watchPrompt(candidate);
  const claim = await deps.reserve(workspaceId, event.eventId, WATCH_AGENT_INSTRUCTIONS, prompt);
  if (claim !== 'reserved') return { accepted: false, status: claim };
  // Retain the reservation on a failed or unknown provider call, so a retry cannot bill twice.
  let result: Awaited<ReturnType<WatchServices['generate']>>;
  try { result = await deps.generate(WATCH_AGENT_INSTRUCTIONS, prompt); }
  catch { throw new DomainError('WATCH_MODEL_UNAVAILABLE', 'Модель не завершила анализ. Повтор события не запускает второй платный запрос.', 503); }
  await deps.settle(workspaceId, event.eventId, result.usage);
  let decision: WatchDecision;
  try { decision = parseWatchDecision(result.text); }
  catch { throw new DomainError('WATCH_MODEL_INVALID_OUTPUT', 'Модель не вернула корректное решение.', 502); }
  if (!watchDecisionMatchesLevel(decision, event)) return { accepted: true, status: 'ignored' };
  const alert = formatWatchTelegram(candidate, decision);
  if (!alert) return { accepted: true, status: 'ignored' };
  if (!watchEventsEnabled()) return { accepted: true, status: 'disabled' };
  const expiresAt = new Date(new Date(event.observedAt).getTime() + 15 * 60_000);
  if (expiresAt.getTime() <= now.getTime()) return { accepted: true, status: 'stale' };
  const enqueued = await deps.enqueue(workspaceId, event.eventId, alert, expiresAt);
  if (!enqueued) return { accepted: true, status: 'stale' };
  const delivery = await deps.deliver(workspaceId, event.eventId);
  return { accepted: true, status: !watchEventsEnabled() ? 'disabled' : delivery === 'none' ? 'queued' : delivery };
}
