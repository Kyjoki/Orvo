import type { ConversationInput, InputRequest } from 'eve/client';
import { DomainError } from '../shared/types';

type BoundTask = { id: string; revision: number; workflowRunId?: string; inputReply?: string };
export function assertBoundRuntime(task: BoundTask, payload: Record<string, unknown>) {
  if (!task.workflowRunId || payload.runtimeId !== task.workflowRunId) throw new DomainError('STALE_RUNTIME_CONTROL', 'Команда относится к другой сессии исполнения.', 409);
}

// Returning null acknowledges an already settled, identical response. It never
// selects a newer request that happens to have the same available option.
export function resolveBoundRuntimeInput(task: BoundTask, action: string, payload: Record<string, unknown>, inputs: readonly ConversationInput[]): InputRequest | null {
  assertBoundRuntime(task, payload);
  if (typeof payload.requestId !== 'string') throw new DomainError('RUNTIME_INPUT_REQUIRED', 'Команда должна быть привязана к конкретному запросу ввода.', 409);
  const entry = inputs.find((input) => input.request.requestId === payload.requestId);
  if (!entry) throw new DomainError('STALE_RUNTIME_INPUT', 'Этот запрос ввода уже закрыт. Обновите состояние.', 409);
  const request = entry.request;
  if (action === 'approve' || action === 'reject') {
    if (typeof payload.approvalId !== 'string' || !request.prompt.startsWith(`[approval:${payload.approvalId}]`)) throw new DomainError('APPROVAL_INPUT_MISMATCH', 'Подтверждение относится к другой операции.', 409);
  } else if (action === 'resume') {
    if (!request.prompt.startsWith(`[pause:${task.id}:${task.revision}:`) && !request.prompt.startsWith(`[input:${task.id}:${task.revision}:`)) throw new DomainError('RUNTIME_INPUT_MISMATCH', 'Продолжение относится к другому этапу.', 409);
  } else throw new DomainError('INVALID_RUNTIME_CONTROL', 'Неизвестная команда продолжения.', 400);
  if (entry.status === 'open') return request;
  const optionId = action === 'approve' ? 'approve' : action === 'reject' ? 'deny' : 'resume';
  const responseMatches = request.options?.some((option) => option.id === optionId)
    ? entry.response?.optionId === optionId
    : entry.response?.text === String(payload.text ?? payload.comment ?? task.inputReply ?? '');
  if (entry.status === 'settled' && responseMatches) return null;
  throw new DomainError('STALE_RUNTIME_INPUT', 'Ответ не совпадает с ранее принятым решением.', 409);
}
