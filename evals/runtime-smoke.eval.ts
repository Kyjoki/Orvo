import { defineEval } from 'eve/evals';
import { equals } from 'eve/evals/expect';
import { getTask, prepareTask } from '../agent/lib/domain-rpc';

// Prepare a fresh task through authenticated Orvo APIs, then pass its ID here.
// The domain RPC continues to use the running Next process as the sole DB owner.
export default defineEval({
  async test(t) {
    const taskId = process.env.ORVO_EVAL_TASK_ID;
    const secret = process.env.ORVO_RUNTIME_SECRET;
    if (process.env.ORVO_TEST_MODE !== '1' || !taskId || !secret) {
      t.skip('Requires explicit ORVO_TEST_MODE=1, ORVO_EVAL_TASK_ID and runtime secret.');
      return;
    }
    const context = await prepareTask(taskId);
    await t.require(context.settings.provider, equals('test'));
    const headers = { authorization: `Bearer ${secret}`, 'x-orvo-task-id': taskId };
    const session = await t.session({ headers });
    await session.send(JSON.stringify({ taskId }), { headers });
    t.calledTool('run_task');
    t.succeeded();
    const task = await getTask(taskId);
    await t.require(task.status, equals('ready_for_review'));
  },
});
