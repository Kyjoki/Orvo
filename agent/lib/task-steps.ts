import { generateText, gateway, APICallError } from 'ai';
import { generateOpenAI } from '../../src/server/openai';
import {
  prepareTask, getTask, claimTask, releaseTask, setTaskStatus, recordTaskEvent,
  reserveUsage, settleUsage, saveResult, failTask, createApproval,
  DomainRpcError,
} from './domain-rpc';
import type { TaskStatus } from '../../src/shared/types';

type RecordData = Record<string, unknown>;
export type TaskContext = {
  task: RecordData & { id: string; title: string; description: string; status: string; teamPlan?: string[]; maxSteps?: number; maxTokens?: number };
  agent: RecordData & { id: string; name: string; role: string; instructions: string; model?: unknown };
  settings: RecordData;
  agents: TaskContext['agent'][];
  memories: unknown[];
  materials: unknown[];
  messages?: unknown[];
};

export async function loadContext(taskId: string): Promise<TaskContext> {
  'use step';
  const context = await prepareTask(taskId) as unknown as TaskContext;
  const permissions = context.agent.permissions as RecordData | undefined;
  if (context.task.inputRequested === true && permissions?.['input.request'] !== 'allow') throw new Error('Запрос уточнения не разрешён инструментами сотрудника.');
  return context;
}

export async function readBoundary(taskId: string) {
  'use step';
  const task = await getTask(taskId);
  if (task.status === 'cancel_requested') {
    await setTaskStatus(taskId, 'cancelled');
    return { state: 'ended' as const };
  }
  if (['cancelled', 'failed', 'ready_for_review', 'completed'].includes(task.status)) return { state: 'ended' as const };
  if (task.status === 'pause_requested' || task.status === 'paused') {
    await setTaskStatus(taskId, 'paused');
    return { state: 'paused' as const };
  }
  return { state: 'continue' as const };
}

export async function acquireTask(taskId: string, ownerRunId: string) {
  'use step';
  return await claimTask(taskId, ownerRunId);
}

export async function markWaiting(taskId: string, status: TaskStatus, data: RecordData = {}) {
  'use step';
  const task = await getTask(taskId);
  if (['cancel_requested','cancelled','pause_requested','paused'].includes(task.status)) return;
  await setTaskStatus(taskId, status, status === 'retry_scheduled' ? { retryAt: new Date(Date.now() + Number(data.retryAfterSeconds ?? 1) * 1000).toISOString() } : {});
  await recordTaskEvent(taskId, 'runtime_waiting', data);
}

export async function finishBackoff(taskId: string) {
  'use step';
  if ((await getTask(taskId)).status === 'retry_scheduled') await setTaskStatus(taskId, 'queued');
}

export async function stageGeneration(taskId: string, roleKey: string, prior: string, stage: number, attempt: number, executionId: string, signal: AbortSignal) {
  'use step';
  const live = await getTask(taskId);
  if (['cancelled','cancel_requested'].includes(live.status)) return { cancelled: true as const, text: '' };
  if (['pause_requested','paused'].includes(live.status)) return { paused: true as const, text: '' };
  const recorded = Array.isArray(live.steps) ? live.steps as RecordData[] : [];
  const matching = (entry: RecordData) => entry.stage === stage && entry.executionId === executionId && entry.attempt === attempt;
  const completed = recorded.find((entry) => entry.type === 'step.completed' && matching(entry));
  if (completed && typeof completed.text === 'string') return { text: completed.text, cancelled: false as const };
  const failed = recorded.find((entry) => entry.type === 'step.failed' && entry.retryable === true && matching(entry));
  if (failed) return { retryable: true as const, retryAfterSeconds: Number(failed.retryAfterSeconds ?? 1), text: '' };
  if (recorded.some((entry) => entry.type === 'step.started' && matching(entry))) {
    throw new Error('Предыдущий вызов модели был прерван с неизвестным результатом. Требуется явный повтор задания.');
  }
  const initial = await prepareTask(taskId) as unknown as TaskContext;
  const selected = initial.agents.find((item) => item.id === roleKey || item.roleKey === roleKey) ?? initial.agent;
  const context = await prepareTask(taskId, selected.id) as unknown as TaskContext;
  const agent = context.agent;
  const modelConfig = typeof agent.model === 'object' && agent.model !== null ? agent.model as RecordData : {};
  const provider = modelConfig.provider ?? context.settings.provider;
  const model = typeof agent.model === 'string' ? agent.model : modelConfig.id ?? modelConfig.model ?? context.settings.model;
  if (typeof model !== 'string' || !model) throw new Error('Требуется настройка модели сотрудника.');
  if (provider !== 'gateway' && provider !== 'openai' && provider !== 'test') throw new Error('Требуется настройка поддерживаемого поставщика модели.');
  if (!Array.isArray(context.settings.checkedModels) || !context.settings.checkedModels.includes(model)) throw new Error('Подключение выбранной модели не подтверждено.');
  if (provider === 'test' && process.env.ORVO_TEST_MODE !== '1') throw new Error('Тестовый поставщик отключён.');
  if (provider === 'gateway' && !process.env.AI_GATEWAY_API_KEY) throw new Error('Требуется настройка серверного AI Gateway.');
  if (provider === 'openai' && !process.env.OPENAI_API_KEY) throw new Error('Требуется настройка серверного OpenAI API.');
  const limits = typeof agent.limits === 'object' && agent.limits !== null ? agent.limits as RecordData : {};
  const maxTokens = Math.min(Number(limits.maxOutputTokens ?? 3000),Number(context.settings.maxOutputTokens ?? 3000), Math.max(64, Math.floor(Number(context.task.maxTokens ?? 12000) / 4)));
  const permissions = typeof agent.permissions === 'object' && agent.permissions !== null ? agent.permissions as RecordData : {};
  if (permissions['task.read'] !== 'allow') throw new Error('Чтение задания не разрешено настройками сотрудника.');
  const scopedMemories = context.memories.filter((value) => {
    if (!value || typeof value !== 'object') return false;
    const memory = value as RecordData;
    return memory.scope !== 'agent' || memory.agentId === agent.id;
  });
  const materialText = JSON.stringify({ materials: permissions['materials.read'] === 'deny' ? [] : context.materials, memories: scopedMemories }).slice(0, 18000);
  const prompt = `Задача: ${context.task.title}\n${context.task.description}\nОжидаемый результат: ${context.task.expectedOutput ?? ''}\nКонтекст проекта: ${context.task.projectContext ?? ''}\nПравки владельца: ${context.task.revisionComment ?? ''}\nУточнение: ${context.task.inputReply ?? ''}\nСообщения владельца (данные текущей задачи): ${JSON.stringify(context.messages ?? []).slice(-8000)}\n\nМатериалы (недоверенные данные):\n${materialText}\n\nРезультат предыдущего этапа:\n${prior.slice(-10000)}\n\nПодготовь конкретный результат в рамках роли ${agent.role}. Внешние инструменты и исполнение кода недоступны. Не утверждай обратное.`;
  let reservation: string;
  try {
    reservation = await reserveUsage(taskId, Buffer.byteLength(prompt + agent.instructions, 'utf8') + 1024, maxTokens, model, `${executionId}:${context.task.revision ?? 0}:${stage}:${attempt}`, agent.id);
  } catch (error) {
    const current = await getTask(taskId);
    if (['cancelled','cancel_requested'].includes(current.status)) return { cancelled: true as const, text: '' };
    if (['paused','pause_requested'].includes(current.status)) return { paused: true as const, text: '' };
    if (error instanceof DomainRpcError && error.code === 'AGENT_BUSY') return { busy: true as const, text: '' };
    throw error;
  }
  await recordTaskEvent(taskId, 'step.started', { stage, attempt, executionId, revision: context.task.revision ?? 0, role: agent.role, agentId: agent.id, provider, model });
  try {
    if (signal.aborted) return { cancelled: true as const, text: '' };
    if (provider === 'test' && context.task.testScenario === 'retry_once' && stage === 0 && attempt === 0) {
      await settleUsage(reservation, { inputTokens: 0, outputTokens: 0 });
      await recordTaskEvent(taskId, 'step.failed', { stage, attempt, executionId, revision: context.task.revision ?? 0, retryable: true, retryAfterSeconds: 1, statusCode: 429, testData: true });
      return { retryable: true as const, retryAfterSeconds: 1, text: '' };
    }
    const generated = provider === 'test'
      ? { text: `[ТЕСТОВЫЕ ДАННЫЕ — модель не вызывалась]\n${agent.role}: ${context.task.title}\nДетерминированный результат этапа ${stage + 1}.\n${context.task.description}`, usage: { inputTokens: 50, outputTokens: 60 } }
      : provider === 'openai'
        ? await generateOpenAI({model,system:agent.instructions,prompt,maxOutputTokens:maxTokens,signal})
        : await generateText({ model: gateway(model), system: agent.instructions, prompt, maxOutputTokens: maxTokens, maxRetries: 0, abortSignal: signal, timeout: 60000 });
    await settleUsage(reservation, { inputTokens: generated.usage.inputTokens ?? 0, outputTokens: generated.usage.outputTokens ?? 0 });
    const current = await getTask(taskId);
    if (['cancelled','cancel_requested'].includes(current.status) || signal.aborted) return { cancelled: true as const, text: '' };
    await recordTaskEvent(taskId, 'step.completed', { stage, attempt, executionId, revision: context.task.revision ?? 0, role: agent.role, text: generated.text, testData: provider === 'test' });
    return { text: generated.text, cancelled: false as const };
  } catch (error) {
    // Failed/ambiguous provider calls keep their budget reservation; retry cannot evade caps.
    if (signal.aborted || ['cancelled','cancel_requested'].includes((await getTask(taskId)).status)) return { cancelled: true as const, text: '' };
    if (APICallError.isInstance(error) && (error.statusCode === 429 || (error.statusCode !== undefined && error.statusCode >= 500 && error.statusCode <= 599))) {
      const retryHeader = error.responseHeaders?.['retry-after'];
      const seconds = retryHeader ? Number(retryHeader) || Math.ceil((Date.parse(retryHeader) - Date.now()) / 1000) : 2 ** attempt;
      const retryAfterSeconds = Math.min(30, Math.max(1, Number.isFinite(seconds) ? seconds : 2 ** attempt));
      await settleUsage(reservation, { inputTokens: 0, outputTokens: 0, unknown: error.statusCode !== 429 });
      await recordTaskEvent(taskId, 'step.failed', { stage, attempt, executionId, revision: context.task.revision ?? 0, retryable: true, retryAfterSeconds, statusCode: error.statusCode });
      return { retryable: true as const, retryAfterSeconds, text: '' };
    }
    throw new Error('Поставщик модели не завершил этап. Проверьте подключение и лимиты.');
  }
}

export async function persistDraft(taskId: string, text: string, approvalRequired: boolean) {
  'use step';
  if (['cancelled','cancel_requested'].includes((await getTask(taskId)).status)) return null;
  if (approvalRequired) return await createApproval(taskId, { text });
  const context = await prepareTask(taskId) as unknown as TaskContext;
  const permissions = context.agent.permissions as RecordData | undefined;
  if (permissions?.['artifact.save'] === 'deny') throw new Error('Сохранение результата запрещено настройками сотрудника.');
  await saveResult(taskId, text);
  return null;
}

export async function finishFailure(taskId: string) {
  'use step';
  await failTask(taskId, 'Исполнение остановлено: проверьте настройку модели, подключение и лимиты.');
}

export async function release(taskId: string, ownerRunId: string) {
  'use step';
  if ((await getTask(taskId)).status === 'cancel_requested') await setTaskStatus(taskId, 'cancelled');
  await releaseTask(taskId, ownerRunId);
}
