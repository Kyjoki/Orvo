import { defineWorkflowTool } from 'eve/tools';
import { sleep } from 'workflow';
import { z } from 'zod';
import { loadContext, readBoundary, acquireTask, markWaiting, finishBackoff, stageGeneration, persistDraft, finishFailure, release } from '../lib/task-steps';

export default defineWorkflowTool({
  description: 'Run one server-authorized Orvo task with bounded specialist stages.',
  inputSchema: z.object({ taskId: z.string().min(1).max(100) }),
  async execute({ taskId }, ctx) {
    'use workflow';
    let prior = '';
    let ownsClaim = false;
    let attempt = 0;
    try {
      const context = await loadContext(taskId);
      const scheduledAt = typeof context.task.scheduledAt === 'string' ? context.task.scheduledAt : null;
      if (scheduledAt) await sleep(new Date(scheduledAt));
      const roles = (context.task.teamPlan?.length ? context.task.teamPlan : [context.agent.id]).slice(0, Math.min(3, context.task.maxSteps ?? 3));
      // The extra iteration commits the result after checking controls again.
      for (let index = 0; index <= roles.length;) {
        const boundary = await readBoundary(taskId);
        if (boundary.state === 'ended') return { cancelled: true };
        if (boundary.state === 'paused') {
          ownsClaim = false;
          const answer = await ctx.ask({ prompt: `[pause:${taskId}:${context.task.revision ?? 0}:${index}] Задача на паузе. Продолжить исполнение?`, display: 'confirmation', options: [{ id: 'resume', label: 'Продолжить' }, { id: 'cancel', label: 'Отменить' }] });
          if (answer.status !== 'answered' || answer.optionId !== 'resume') return { cancelled: true };
          continue;
        }
        if (!ownsClaim) {
          ownsClaim = await acquireTask(taskId, ctx.session.id);
          if (!ownsClaim) { await sleep('2s'); continue; }
        }
        if (index === roles.length) {
          if (typeof context.task.proposeMemory === 'string' && context.task.proposeMemory) {
            const approval = await persistDraft(taskId, context.task.proposeMemory, true);
            if (approval) {
              ownsClaim = false;
              if (approval.state === 'pending') await ctx.ask({ prompt: `[approval:${approval.id}] Опубликовать предложенную запись в общей памяти? Подтверждается только неизменяемый текст операции в карточке Orvo.`, display: 'confirmation', options: [{ id: 'approve', label: 'Опубликовать' }, { id: 'deny', label: 'Отклонить' }] });
              // The authenticated domain command consumes this operation once.
              while (!(await acquireTask(taskId, ctx.session.id))) {
                if ((await readBoundary(taskId)).state === 'ended') return { cancelled: true };
                await sleep('2s');
              }
              ownsClaim = true;
            }
          }
          await persistDraft(taskId, prior, false);
          return { finished: true };
        }
        if (index === 0 && context.task.inputRequested === true && !prior) {
          await markWaiting(taskId, 'waiting_for_input', { kind: 'input' });
          ownsClaim = false;
          const answer = await ctx.ask({ prompt: `[input:${taskId}:${context.task.revision ?? 0}:${index}] Добавьте уточнение для выполнения задачи.`, allowFreeform: true });
          if (answer.status !== 'answered') return { cancelled: true };
          prior = answer.text ?? 'Уточнение получено.';
          continue;
        }
        const result = await stageGeneration(taskId, roles[index], prior, index, attempt, ctx.session.id, ctx.abortSignal);
        if (result.cancelled) return { cancelled: true };
        if (result.paused) continue;
        if (result.busy) { await sleep('2s'); continue; }
        if (result.retryable) {
          if (attempt >= 2) throw new Error('Достигнут лимит трёх попыток поставщика модели.');
          attempt += 1;
          await markWaiting(taskId, 'retry_scheduled', { retryAfterSeconds: result.retryAfterSeconds, attempt });
          await release(taskId, ctx.session.id);
          ownsClaim = false;
          await sleep(result.retryAfterSeconds * 1000);
          await finishBackoff(taskId);
          continue;
        }
        prior = result.text;
        index += 1;
        attempt = 0;
      }
      return { finished: true };
    } catch {
      await finishFailure(taskId);
      return { failed: true };
    } finally {
      await release(taskId, ctx.session.id);
    }
  },
});
