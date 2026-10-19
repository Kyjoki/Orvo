import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, conversationReducer, openConversationInputs } from 'eve/client';

const origin = process.env.ORVO_RUNTIME_URL ?? 'http://127.0.0.1:3000';
const access = JSON.parse(await readFile('.orvo/test-access.json', 'utf8')) as { email: string; password: string };
const login = await fetch(`${origin}/api/auth/sign-in/email`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(access), signal: AbortSignal.timeout(60000),
});
if (!login.ok) throw new Error(`Test owner login failed (${login.status}).`);
const cookie = login.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
if (!cookie) throw new Error('Test owner cookie was not returned.');
async function command(type: string, payload: Record<string, unknown> = {}) {
  const requestId = randomUUID();
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await fetch(`${origin}/api/command`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ type, payload, requestId }), signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    if (data.error?.code === 'RUNTIME_INPUT_NOT_READY') { await delay(500); continue; }
    if (!response.ok) throw new Error(`${type}: ${data.error?.code ?? response.status}: ${data.error?.message ?? 'failed'}`);
    return data.result;
  }
  throw new Error(`${type}: runtime input was not ready.`);
}
async function state() {
  const response = await fetch(`${origin}/api/state`, { headers: { cookie }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`State failed (${response.status}).`);
  return await response.json();
}
async function waitTask(taskId: string, statuses: string[], timeout = 120000): Promise<any> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const snapshot = await state();
    const task = snapshot.tasks.find((entry: any) => entry.id === taskId);
    if (task && statuses.includes(task.status)) return { task, snapshot };
    if (task?.status === 'failed') throw new Error(`Task failed: ${task.error ?? 'unknown'}`);
    await delay(500); // Test polling only. Actual scheduling belongs to eve.
  }
  throw new Error(`Timed out waiting for ${statuses.join('/')} on task ${taskId}.`);
}
if (process.argv.includes('--prepare-recovery')) {
  const snapshot = await state();
  const created = await command('task.create', { title: '[ТЕСТ] Восстановление после перезапуска', description: 'Продолжи ту же durable сессию после перезапуска сервера.', agentId: snapshot.agents[0].id, inputRequested: true });
  const waiting = await waitTask(created.id, ['waiting_for_input']);
  const client = new Client({ host: origin, auth: { bearer: process.env.ORVO_RUNTIME_SECRET ?? '' }, headers: { 'x-orvo-task-id': created.id } });
  let requestId: string | undefined;
  for (let attempt = 0; attempt < 20 && !requestId; attempt++) {
    const history = await client.sessions.attach(waiting.task.workflowRunId).snapshot();
    let projection = conversationReducer.initial();
    for (const event of history.events) projection = conversationReducer.reduce(projection, event);
    requestId = openConversationInputs(projection)[0]?.request.requestId;
    if (!requestId) await delay(500);
  }
  assert.ok(requestId, 'Durable input request must be recorded before server shutdown.');
  await writeFile('.orvo/recovery-task.json', JSON.stringify({ taskId: created.id, runtimeId: waiting.task.workflowRunId, requestId }));
  console.log('prepared: durable request recorded; production server can be restarted');
}
if (process.argv.includes('--finish-recovery')) {
  const saved = JSON.parse(await readFile('.orvo/recovery-task.json', 'utf8'));
  const before = await state();
  const recoveredTask = before.tasks.find((entry: any) => entry.id === saved.taskId);
  assert.equal(recoveredTask.workflowRunId, saved.runtimeId);
  if (recoveredTask.status !== 'ready_for_review') await command('task.resume', { id: saved.taskId, comment: 'ТЕСТОВЫЕ ДАННЫЕ: продолжаем после перезапуска.' });
  const after = await waitTask(saved.taskId, ['ready_for_review']);
  assert.equal(after.task.workflowRunId, saved.runtimeId);
  assert.equal(after.snapshot.usage.filter((entry: any) => entry.taskId === saved.taskId).length, 1);
  assert.equal(after.snapshot.artifacts.filter((entry: any) => entry.taskId === saved.taskId).length, 1);
  await writeFile('.orvo/runtime-recovery-report.json', JSON.stringify({ testData: true, passed: true, at: new Date().toISOString(), taskId: saved.taskId, sameRuntimeId: true, modelSteps: 1, artifacts: 1 }, null, 2));
  console.log('passed: production restart recovered the same session, one specialist step, one artifact');
}
if (process.argv.includes('--inspect')) {
  const snapshot = await state();
  const task = snapshot.tasks.findLast((entry: any) => entry.title.startsWith('[ТЕСТ]') && ['paused','waiting_for_input','waiting_for_approval','queued','running','retry_scheduled'].includes(entry.status));
  if (!task) throw new Error('No active fixture task found.');
  const client = new Client({ host: origin, auth: { bearer: process.env.ORVO_RUNTIME_SECRET ?? '' }, headers: { 'x-orvo-task-id': task.id } });
  const history = await client.sessions.attach(task.workflowRunId).snapshot();
  let projection = conversationReducer.initial();
  for (const event of history.events) projection = conversationReducer.reduce(projection, event);
  console.log(JSON.stringify({ status: task.status, runtimeId: task.workflowRunId, recentEvents: history.events.slice(-12).map((entry) => entry.type), inputs: openConversationInputs(projection).map((entry) => ({ id: entry.request.requestId, prompt: entry.request.prompt })) }));
}
if (!process.argv.some((argument) => ['--inspect','--prepare-recovery','--finish-recovery'].includes(argument))) {
await command('agents.seed');
const configured = await state();
if (configured.settings.provider !== 'test' || configured.settings.model !== 'orvo-fixture-v1') await command('settings.save', { provider: 'test', model: 'orvo-fixture-v1' });
if (!configured.settings.checkedModels?.includes('orvo-fixture-v1')) await command('settings.checkModel');
const initial = await state();
for (const task of initial.tasks.filter((entry: any) => entry.title.startsWith('[ТЕСТ]') && ['queued','scheduled','running','pause_requested','paused','waiting_for_input','waiting_for_approval','cancel_requested'].includes(entry.status))) {
  await command('task.cancel', { id: task.id });
}
assert.equal(initial.agents.length, 12);
const uniqueIds = new Set(initial.agents.map((agent: any) => agent.id));
assert.equal(uniqueIds.size, 12);
const reports: Record<string, unknown> = {};
const checkpoint = async () => writeFile('.orvo/runtime-smoke-report.json', JSON.stringify({ testData: true, partial: true, at: new Date().toISOString(), reports }, null, 2));
const normal = await command('task.create', { title: '[ТЕСТ] Реальное durable исполнение', description: 'Подготовь короткий проверяемый результат.', agentId: initial.agents[0].id });
const generated = await waitTask(normal.id, ['ready_for_review']);
const artifact = generated.snapshot.artifacts.find((entry: any) => entry.taskId === normal.id);
assert.ok(artifact?.text.includes('ТЕСТОВЫЕ ДАННЫЕ'));
assert.ok(generated.task.workflowRunId);
assert.ok(generated.snapshot.usage.some((entry: any) => entry.taskId === normal.id && entry.state === 'settled'));
reports.generation = { id: normal.id, status: generated.task.status, runtimeId: generated.task.workflowRunId, artifact: artifact.id };
console.log('passed: generation');
await checkpoint();

const team = await command('task.create', { title: '[ТЕСТ] Последовательная команда', description: 'Подготовь результат и проверь его.', agentId: initial.agents[0].id, teamPlan: ['architect', 'frontend-developer', 'code-reviewer'] });
const teamDone = await waitTask(team.id, ['ready_for_review']);
const teamUsage = teamDone.snapshot.usage.filter((entry: any) => entry.taskId === team.id);
assert.equal(teamUsage.length, 3);
assert.equal(new Set(teamUsage.map((entry: any) => entry.agentId)).size, 3);
reports.team = { id: team.id, status: teamDone.task.status, specialistSteps: 3 };
console.log('passed: sequential team');
await checkpoint();

const retry = await command('task.create', { title: '[ТЕСТ] Durable backoff', description: 'Проверь один управляемый ответ 429 и повтор.', agentId: initial.agents[5].id, testScenario: 'retry_once' });
const retried = await waitTask(retry.id, ['ready_for_review']);
const retryUsage = retried.snapshot.usage.filter((entry: any) => entry.taskId === retry.id);
assert.equal(retryUsage.length, 2);
assert.ok(retried.snapshot.events.some((entry: any) => entry.taskId === retry.id && entry.type === 'runtime_waiting' && entry.retryAfterSeconds === 1));
reports.retry = { id: retry.id, status: retried.task.status, attempts: 2 };
console.log('passed: durable retry');
await checkpoint();

const approval = await command('task.create', { title: '[ТЕСТ] Подтверждение общей памяти', description: 'Подготовь правило.', agentId: initial.agents[1].id, proposeMemory: 'ТЕСТОВЫЕ ДАННЫЕ: подтверждённое правило smoke.' });
const waiting = await waitTask(approval.id, ['waiting_for_approval']);
const operation = waiting.snapshot.approvals.find((entry: any) => entry.taskId === approval.id && entry.state === 'pending');
assert.ok(operation);
const memoryCount = waiting.snapshot.memories.length;
await command('approval.decide', { id: operation.id, version: operation.version, decision: 'approve' });
const approved = await waitTask(approval.id, ['ready_for_review']);
assert.equal(approved.snapshot.memories.length, memoryCount + 1);
assert.equal(approved.task.workflowRunId, waiting.task.workflowRunId);
await assert.rejects(() => command('approval.decide', { id: operation.id, decision: 'approve' }));
reports.approval = { id: approval.id, status: approved.task.status, runtimeId: approved.task.workflowRunId, oneTime: true };
console.log('passed: one-time approval');
await checkpoint();

const question = await command('task.create', { title: '[ТЕСТ] Ожидание ввода', description: 'Уточни требование перед результатом.', agentId: initial.agents[2].id, inputRequested: true });
const inputWait = await waitTask(question.id, ['waiting_for_input']);
await command('task.resume', { id: question.id, comment: 'ТЕСТОВЫЕ ДАННЫЕ: краткий ответ.' });
const inputDone = await waitTask(question.id, ['ready_for_review']);
assert.equal(inputDone.task.workflowRunId, inputWait.task.workflowRunId);
reports.input = { id: question.id, status: inputDone.task.status, runtimeId: inputDone.task.workflowRunId };
console.log('passed: input');
await checkpoint();

const paused = await command('task.create', { title: '[ТЕСТ] Планирование и пауза', description: 'Проверь отложенное исполнение.', agentId: initial.agents[3].id, scheduledAt: new Date(Date.now() + 8000).toISOString() });
await command('task.pause', { id: paused.id });
const pausedState = await waitTask(paused.id, ['paused']);
await delay(8500);
await command('task.resume', { id: paused.id });
const resumed = await waitTask(paused.id, ['ready_for_review']);
assert.equal(resumed.task.workflowRunId, pausedState.task.workflowRunId);
reports.pause = { id: paused.id, status: resumed.task.status, runtimeId: resumed.task.workflowRunId };
console.log('passed: pause/resume');
await checkpoint();

const cancelled = await command('task.create', { title: '[ТЕСТ] Отмена', description: 'После отмены модель не вызывается.', agentId: initial.agents[4].id, scheduledAt: new Date(Date.now() + 30000).toISOString() });
await command('task.cancel', { id: cancelled.id });
const cancelledState = await waitTask(cancelled.id, ['cancelled']);
assert.equal(cancelledState.snapshot.usage.filter((entry: any) => entry.taskId === cancelled.id).length, 0);
reports.cancel = { id: cancelled.id, status: cancelledState.task.status, modelCalls: 0 };
console.log('passed: cancellation');
await checkpoint();

await command('task.accept', { id: normal.id });
await writeFile('.orvo/runtime-smoke-report.json', JSON.stringify({ testData: true, at: new Date().toISOString(), reports }, null, 2));
console.log(JSON.stringify({ passed: Object.keys(reports), agents: 12, report: '.orvo/runtime-smoke-report.json' }));
}
