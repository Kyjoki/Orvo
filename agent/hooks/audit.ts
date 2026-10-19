import { defineHook } from 'eve/hooks';
import { recordTaskEvent, setTaskStatus, releaseTask } from '../lib/domain-rpc';

// Audit is supplementary; critical status and result commits are durable steps.
export default defineHook({
  events: {
    async 'turn.cancelled'(_event, ctx) {
      const taskId = ctx.session.auth.initiator?.attributes.taskId;
      if (typeof taskId === 'string') {
        await setTaskStatus(taskId, 'cancelled');
        await releaseTask(taskId, ctx.session.id);
      }
    },
    async 'input.requested'(event, ctx) {
      const taskId = ctx.session.auth.initiator?.attributes.taskId;
      if (typeof taskId === 'string') await recordTaskEvent(taskId, 'runtime_input', { requests: event.data.requests });
    },
    async 'input.resolved'(event, ctx) {
      const taskId = ctx.session.auth.initiator?.attributes.taskId;
      if (typeof taskId === 'string') await recordTaskEvent(taskId, 'runtime_input_resolved', { resolutions: event.data.resolutions });
    },
  },
});
