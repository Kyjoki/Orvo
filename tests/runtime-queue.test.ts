import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validWorkspaceId} from '../src/server/runtime-queue';
import {validReconcileRequest} from '../src/app/ops/reconcile/route';
import {POST as queueCallback} from '../src/app/api/queues/runtime/route';

test('queue payload is scoped to a simple workspace identifier',()=>{
  assert.equal(validWorkspaceId('workspace_123'),true);
  for(const value of ['', '../other', 'a/b', 'a'.repeat(129), null, {}])assert.equal(validWorkspaceId(value),false);
});

test('reconciler requires the dedicated secret in the expected header',()=>{
  const secret='x'.repeat(32);
  assert.equal(validReconcileRequest(new Request('https://example.test/ops/reconcile',{method:'POST'}),secret),false);
  assert.equal(validReconcileRequest(new Request('https://example.test/ops/reconcile',{method:'POST',headers:{authorization:`Bearer ${secret}`}}),secret),false);
  assert.equal(validReconcileRequest(new Request('https://example.test/ops/reconcile',{method:'POST',headers:{'x-orvo-reconcile-secret':secret}}),secret),true);
  assert.equal(validReconcileRequest(new Request('https://example.test/ops/reconcile',{method:'POST',headers:{'x-orvo-reconcile-secret':secret+'!'}}),secret),false);
  assert.equal(validReconcileRequest(new Request('https://example.test/ops/reconcile',{method:'POST',headers:{'x-orvo-reconcile-secret':secret}}),'short'),false);
});

test('queue callback is not callable in the local runtime',async()=>{
  const prior=process.env.VERCEL;
  delete process.env.VERCEL;
  try{
    const response=await queueCallback(new Request('http://localhost/api/queues/runtime',{method:'POST'}));
    assert.equal(response.status,403);
  }finally{if(prior===undefined)delete process.env.VERCEL;else process.env.VERCEL=prior;}
});
