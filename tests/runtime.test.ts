import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationInput, InputRequest } from 'eve/client';
import { resolveBoundRuntimeInput } from '../src/server/runtime-bindings';
import { stageGeneration } from '../agent/lib/task-steps';

const taskBinding = { id: 'task-one', revision: 0, workflowRunId: 'run-one' };
const approvalPayload = { runtimeId: 'run-one', requestId: 'request-one', approvalId: 'operation-one' };
function input(requestId = 'request-one', prompt = '[approval:operation-one] Publish?'): ConversationInput {
  return { status: 'open', turnId: 'turn_0', stepIndex: 0, request: { kind: 'question', requestId, prompt, action: { kind: 'tool-call', toolName: 'run_task', callId: 'call-one', input: { taskId: 'task-one' } }, options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }] } };
}
test('approval cannot cross session, operation, or request identity', () => {
  assert.throws(() => resolveBoundRuntimeInput(taskBinding, 'approve', { ...approvalPayload, runtimeId: 'run-two' }, [input()]), { code: 'STALE_RUNTIME_CONTROL' });
  assert.throws(() => resolveBoundRuntimeInput(taskBinding, 'approve', { ...approvalPayload, approvalId: 'operation-two' }, [input()]), { code: 'APPROVAL_INPUT_MISMATCH' });
  assert.throws(() => resolveBoundRuntimeInput(taskBinding, 'approve', { ...approvalPayload, requestId: 'missing' }, [input()]), { code: 'STALE_RUNTIME_INPUT' });
  assert.throws(() => resolveBoundRuntimeInput(taskBinding, 'approve', { runtimeId: 'run-one', approvalId: 'operation-one' }, [input()]), { code: 'RUNTIME_INPUT_REQUIRED' });
});
test('replayed settled approval is acknowledged without selecting a later open approval', () => {
  const settled: ConversationInput = { ...input(), status: 'settled', response: { requestId: 'request-one', optionId: 'approve' } };
  const later = input('request-two', '[approval:operation-two] Publish?');
  assert.equal(resolveBoundRuntimeInput(taskBinding, 'approve', approvalPayload, [settled, later]), null);
  assert.throws(() => resolveBoundRuntimeInput(taskBinding, 'reject', approvalPayload, [settled, later]), { code: 'STALE_RUNTIME_INPUT' });
});
test('resume is bound to task revision and the precise pause/input request', () => {
  const paused = input('pause-one', '[pause:task-one:0:1] Continue?');
  paused.request.options = [{ id: 'resume', label: 'Resume' }];
  assert.equal(resolveBoundRuntimeInput(taskBinding, 'resume', { runtimeId: 'run-one', requestId: 'pause-one' }, [paused]), paused.request);
  assert.throws(() => resolveBoundRuntimeInput({ ...taskBinding, revision: 1 }, 'resume', { runtimeId: 'run-one', requestId: 'pause-one' }, [paused]), { code: 'RUNTIME_INPUT_MISMATCH' });
});

const originalFetch = globalThis.fetch;
const oldMode = process.env.ORVO_TEST_MODE, oldSecret = process.env.ORVO_RUNTIME_SECRET;
let live: any, context: any, calls: { action: string; args: any[] }[], reserveFailure: { code: string; message: string } | undefined;
beforeEach(() => {
  process.env.ORVO_TEST_MODE = '1';
  process.env.ORVO_RUNTIME_SECRET = 'fixture-not-a-real-credential-0000000000000000';
  live = { id: 'task-one', title: 'Fixture', description: 'Deterministic test', revision: 0, status: 'running', maxTokens: 24000, steps: [] };
  const agent = { id: 'agent-one', name: 'Fixture specialist', role: 'Architect', roleKey: 'architect', instructions: 'Return a concrete result.', model: null, permissions: { 'task.read': 'allow', 'materials.read': 'allow' }, limits: { maxOutputTokens: 500 } };
  context = { task: live, agent, agents: [agent], settings: { provider: 'test', model: 'fixture', checkedModels: ['fixture'], maxOutputTokens: 1000 }, memories: [], materials: [], messages: [] };
  calls = []; reserveFailure = undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (body.action === 'reserveUsage' && reserveFailure) return Response.json({ error: reserveFailure }, { status: 409 });
    let result: unknown;
    if (body.action === 'getTask') result = live;
    else if (body.action === 'prepareTask') result = context;
    else if (body.action === 'reserveUsage') result = 'reservation-one';
    else result = null;
    return Response.json({ result });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = originalFetch;
  if (oldMode === undefined) delete process.env.ORVO_TEST_MODE; else process.env.ORVO_TEST_MODE = oldMode;
  if (oldSecret === undefined) delete process.env.ORVO_RUNTIME_SECRET; else process.env.ORVO_RUNTIME_SECRET = oldSecret;
});
const stage = (attempt = 0) => stageGeneration('task-one', 'architect', '', 0, attempt, 'execution-one', new AbortController().signal);
test('cancellation and pause prevent new reservations and generation', async () => {
  live.status = 'cancel_requested';
  assert.equal((await stage()).cancelled, true);
  assert.equal(calls.filter((entry) => entry.action === 'reserveUsage').length, 0);
  calls = []; live.status = 'pause_requested';
  assert.equal((await stage()).paused, true);
  assert.equal(calls.filter((entry) => entry.action === 'reserveUsage').length, 0);
});
test('test generation requires both selected test provider and explicit test mode', async () => {
  process.env.ORVO_TEST_MODE = '0';
  await assert.rejects(stage, /Тестовый поставщик отключён/);
  assert.equal(calls.filter((entry) => entry.action === 'reserveUsage').length, 0);
});
test('task read ask fails closed before any model reservation', async () => {
  context.agent.permissions['task.read'] = 'ask';
  await assert.rejects(stage, /Чтение задания не разрешено/);
  assert.equal(calls.filter((entry) => entry.action === 'reserveUsage').length, 0);
});
test('specialist output cap and attribution reach the authoritative budget reservation', async () => {
  const result = await stage();
  assert.ok(result.text.includes('ТЕСТОВЫЕ ДАННЫЕ'));
  const reservation = calls.find((entry) => entry.action === 'reserveUsage')!;
  assert.equal(reservation.args[2], 500);
  assert.equal(reservation.args[4], 'execution-one:0:0:0');
  assert.equal(reservation.args[5], 'agent-one');
});
test('completed checkpoint returns saved output without a new model reservation', async () => {
  live.steps = [{ type: 'step.completed', stage: 0, attempt: 0, executionId: 'execution-one', text: 'Already committed output' }];
  assert.equal((await stage()).text, 'Already committed output');
  assert.equal(calls.filter((entry) => entry.action === 'reserveUsage').length, 0);
});
test('ambiguous interrupted model invocation cannot silently repeat', async () => {
  live.steps = [{ type: 'step.started', stage: 0, attempt: 0, executionId: 'execution-one' }];
  await assert.rejects(stage, /прерван с неизвестным результатом/);
  assert.equal(calls.filter((entry) => entry.action === 'reserveUsage').length, 0);
});
test('explicit fixture 429 produces durable-backoff outcome then a distinct bounded attempt', async () => {
  live.testScenario = 'retry_once';
  const first = await stage(0);
  assert.equal(first.retryable, true);
  assert.equal(first.retryAfterSeconds, 1);
  const second = await stage(1);
  assert.ok(second.text.includes('ТЕСТОВЫЕ ДАННЫЕ'));
  assert.equal(calls.filter((entry) => entry.action === 'reserveUsage').length, 2);
});
test('a busy specialist queues without a provider call or fabricated result', async () => {
  reserveFailure = { code: 'AGENT_BUSY', message: 'Busy' };
  assert.equal((await stage()).busy, true);
  assert.equal(calls.filter((entry) => entry.action === 'settleUsage').length, 0);
});
