import { Client, conversationReducer, openConversationInputs } from 'eve/client';
import { randomUUID } from 'node:crypto';
import { commitRuntimeId, getTask } from './domain';
import { query } from './db';
import { DomainError } from '../shared/types';
import { assertBoundRuntime, resolveBoundRuntimeInput } from './runtime-bindings';
import { runtimeOrigin, runtimeProtectionHeaders } from './runtime-origin';

function runtimeClient(taskId?: string) {
  const secret = process.env.ORVO_RUNTIME_SECRET;
  if (!secret || secret.length < 32) throw new Error('Требуется настройка ORVO_RUNTIME_SECRET (минимум 32 символа).');
  const host = runtimeOrigin();
  return new Client({ host, auth: { bearer: secret }, headers: { ...runtimeProtectionHeaders(new URL(host)), ...(taskId ? { 'x-orvo-task-id': taskId } : {}) }, redirect: 'error' });
}

const UNCERTAIN_MESSAGE='Запуск ИИ имеет неизвестный результат. Требуется ручная сверка durable runtime перед повтором задачи.';
class UncertainRuntimeDelivery extends Error{}

export async function recordRuntimeDispatchState(taskId:string,token:string,runtimeId:string,field:'runtimeDispatchUncertainId'|'runtimeDispatchSentId'){
  const updated=await query<{id:string}>(`UPDATE tasks SET data=jsonb_set(data,$4::text[],to_jsonb($3::text),true),updated_at=now()
    WHERE id=$1 AND dispatch_lease_token=$2 AND dispatch_lease_until>now()
      AND ($5::boolean=false OR status IN ('queued','scheduled')) AND data->>'workflowRunId'=$3 RETURNING id`,
    [taskId,token,runtimeId,[field],field==='runtimeDispatchUncertainId']);
  if(updated.rows.length!==1)throw new Error('Runtime dispatch lease was lost; delivery was not attempted.');
}

export async function markUncertainRuntimeDispatch(taskId:string,token:string,runtimeId:string){
  return query<{id:string}>(`UPDATE tasks SET status='failed',version=version+1,updated_at=now(),
    data=jsonb_set(data,'{error}',to_jsonb($4::text),true)
    WHERE id=$1 AND dispatch_lease_token=$2 AND data->>'workflowRunId'=$3
      AND status IN ('queued','scheduled')
      AND data->>'runtimeDispatchUncertainId'=$3
      AND COALESCE(data->>'runtimeDispatchSentId','')<>$3 RETURNING id`,
    [taskId,token,runtimeId,UNCERTAIN_MESSAGE]);
}

export async function dispatchTask(taskId: string) {
  const token = randomUUID();
  const claim = await query<{id:string}>(`UPDATE tasks SET dispatch_lease_token=$2,dispatch_attempted_at=now(),
    dispatch_lease_until=now()+interval '120 seconds'
    WHERE id=$1 AND (dispatch_lease_until IS NULL OR dispatch_lease_until<now())
    AND status IN ('queued','scheduled') RETURNING id`, [taskId, token]);
  if (!claim.rows.length) {
    const task = await getTask(taskId);
    if (!['queued','scheduled'].includes(task.status)) return {runtimeId:task.workflowRunId,accepted:false};
    throw new Error('Runtime dispatch is leased by another worker; retry the queue delivery.');
  }
  let leaseLost=false;
  let heartbeatPending:Promise<void>=Promise.resolve();
  const heartbeat = setInterval(() => { heartbeatPending=heartbeatPending.then(async()=>{
    const renewed=await query<{id:string}>(`UPDATE tasks SET dispatch_lease_until=now()+interval '120 seconds'
      WHERE id=$1 AND dispatch_lease_token=$2 AND dispatch_lease_until>now() RETURNING id`, [taskId,token]);
    if(renewed.rows.length!==1)leaseLost=true;
  }).catch(()=>{leaseLost=true;}); },30_000);
  heartbeat.unref?.();
  try {
    const existing = await getTask(taskId);
    if (existing.workflowRunId && existing.runtimeDispatchSentId === existing.workflowRunId) {
      return { runtimeId:existing.workflowRunId, accepted:true };
    }
    const client = runtimeClient(taskId);
    const created = existing.workflowRunId ? null : await client.sessions.create();
    const session = created ? created.session : client.sessions.attach(existing.workflowRunId!);
    const runtimeId = session.state.sessionId;
    if (created && await commitRuntimeId(taskId, runtimeId) === false) {
      await session.reset({ reason: 'Duplicate dispatch' });
      return { runtimeId: (await getTask(taskId)).workflowRunId, accepted: true };
    }
    const alreadySent = (await session.snapshot()).events.some((event) => event.type === 'message.received');
    if (alreadySent) {
      await recordRuntimeDispatchState(taskId,token,runtimeId,'runtimeDispatchSentId');
      return {runtimeId,accepted:true};
    }
    if (existing.runtimeDispatchUncertainId === runtimeId) {
      await markUncertainRuntimeDispatch(taskId,token,runtimeId);
      throw new UncertainRuntimeDelivery(UNCERTAIN_MESSAGE);
    }
    if (!alreadySent) {
      // A failed send can still have reached Eve. Record uncertainty before the call,
      // so a retry never starts the model twice when the response was lost.
      await heartbeatPending;
      if(leaseLost)throw new Error('Runtime dispatch lease was lost; delivery was not attempted.');
      await recordRuntimeDispatchState(taskId,token,runtimeId,'runtimeDispatchUncertainId');
      try { await session.send(JSON.stringify({ taskId }), { turnPolicy: 'queue' }); }
      catch {
        const failed=await markUncertainRuntimeDispatch(taskId,token,runtimeId);
        if(!failed.rows.length){
          const current=await getTask(taskId);
          // The durable executor can start before its HTTP acknowledgement is
          // received. Its persisted progress proves the initial message arrived.
          if(current.workflowRunId===runtimeId && ['running','waiting_for_input','waiting_for_approval','pause_requested','retry_scheduled','ready_for_review','completed'].includes(current.status)){
            await recordRuntimeDispatchState(taskId,token,runtimeId,'runtimeDispatchSentId');
            return {runtimeId,accepted:true};
          }
        }
        throw new UncertainRuntimeDelivery(UNCERTAIN_MESSAGE);
      }
      await recordRuntimeDispatchState(taskId,token,runtimeId,'runtimeDispatchSentId');
    }
    return { runtimeId, accepted: true };
  } finally {
    clearInterval(heartbeat);
    await query(`UPDATE tasks SET dispatch_lease_token=NULL,dispatch_lease_until=NULL
      WHERE id=$1 AND dispatch_lease_token=$2`,[taskId,token]);
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
