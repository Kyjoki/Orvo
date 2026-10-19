import { Client, conversationReducer, openConversationInputs } from 'eve/client';
import { commitRuntimeId, getTask, failTask } from './domain';
import { DomainError } from '../shared/types';
import { assertBoundRuntime, resolveBoundRuntimeInput } from './runtime-bindings';
import { runtimeOrigin, runtimeProtectionHeaders } from './runtime-origin';

function runtimeClient(taskId?: string) {
  const secret = process.env.ORVO_RUNTIME_SECRET;
  if (!secret || secret.length < 32) throw new Error('Требуется настройка ORVO_RUNTIME_SECRET (минимум 32 символа).');
  const host = runtimeOrigin();
  return new Client({ host, auth: { bearer: secret }, headers: { ...runtimeProtectionHeaders(new URL(host)), ...(taskId ? { 'x-orvo-task-id': taskId } : {}) }, redirect: 'error' });
}

export async function dispatchTask(taskId: string) {
  try {
    const existing = await getTask(taskId);
    const client = runtimeClient(taskId);
    const created = existing.workflowRunId ? null : await client.sessions.create();
    const session = created ? created.session : client.sessions.attach(existing.workflowRunId!);
    const runtimeId = session.state.sessionId;
    if (created && await commitRuntimeId(taskId, runtimeId) === false) {
      await session.reset({ reason: 'Duplicate dispatch' });
      return { runtimeId: (await getTask(taskId)).workflowRunId, accepted: true };
    }
    const alreadySent = created ? false : (await session.snapshot()).events.some((event) => event.type === 'message.received');
    if (!alreadySent) {
      await session.send(JSON.stringify({ taskId }), { turnPolicy: 'queue' });
    }
    return { runtimeId, accepted: true };
  } catch (error) {
    await failTask(taskId, 'Не удалось запустить durable runtime. Проверьте подключение и серверные настройки.');
    throw error;
  }
}

export async function controlRuntime(taskId: string, action: string, payload: Record<string, unknown> = {}) {
  const task = await getTask(taskId);
  if (!task.workflowRunId) return { accepted: false, reason: 'runtime_not_started' };
  const session = runtimeClient(taskId).sessions.attach(task.workflowRunId);
  if (action === 'cancel') {
    assertBoundRuntime(task, payload);
    await session.cancel();
    return { accepted: true };
  }
  if (action === 'pause') return { accepted: true, boundary: 'next_step' };
  assertBoundRuntime(task, payload);
  if (payload.domainOnly === true) return { accepted: true };
  if (typeof payload.requestId !== 'string') throw new DomainError('RUNTIME_INPUT_REQUIRED', 'Команда должна быть привязана к конкретному запросу ввода.', 409);
  const reducer = conversationReducer;
  let state = reducer.initial();
  const snapshot = await session.snapshot();
  for (const event of snapshot.events) state = reducer.reduce(state, event);
  const desiredOption = action === 'resume' ? 'resume' : action === 'approve' ? 'approve' : action === 'reject' ? 'deny' : undefined;
  const request = resolveBoundRuntimeInput(task, action, payload, Object.values(state.inputs));
  if (!request) return { accepted: true, alreadyDelivered: true };
  const response = desiredOption && request.options?.some((option) => option.id === desiredOption)
    ? { requestId: request.requestId, optionId: desiredOption }
    : { requestId: request.requestId, text: String(payload.text ?? payload.comment ?? task.inputReply ?? '') };
  await session.respond([response]);
  return { accepted: true };
}

// Call before the domain command; the resulting request identity is immutable.
export async function captureRuntimeControl(taskId: string, action: string, payload: Record<string, unknown> = {}) {
  const task = await getTask(taskId);
  if (!task.workflowRunId) return payload;
  const snapshot = await runtimeClient(taskId).sessions.attach(task.workflowRunId).snapshot();
  let state = conversationReducer.initial();
  for (const event of snapshot.events) state = conversationReducer.reduce(state, event);
  const requests = openConversationInputs(state).map((entry) => entry.request);
  const request = requests.find((entry) => action === 'approve' || action === 'reject'
    ? typeof payload.approvalId === 'string' && entry.prompt.startsWith(`[approval:${payload.approvalId}]`)
    : entry.prompt.startsWith(`[pause:${taskId}:${task.revision}:`) || entry.prompt.startsWith(`[input:${taskId}:${task.revision}:`));
  if (!request) {
    if (action === 'resume' && (task.pendingResult || task.status === 'retry_scheduled' || (task.scheduledAt && new Date(task.scheduledAt).getTime() > Date.now()))) return { ...payload, runtimeId: task.workflowRunId, domainOnly: true };
    throw new DomainError('RUNTIME_INPUT_NOT_READY', 'Запрос ещё не опубликован исполнителем. Повторите через секунду.', 409);
  }
  return { ...payload, runtimeId: task.workflowRunId, requestId: request.requestId };
}

export async function runtimeHealth() {
  try { await runtimeClient().health(); return { connected: true }; }
  catch { return { connected: false }; }
}
