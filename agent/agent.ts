import { defineAgent } from 'eve';
import { mockModel } from 'eve/evals';

// This is a deterministic dispatch adapter, not the task's specialist model.
// Paid generation (or explicitly selected test generation) runs in durable steps.
export default defineAgent({
  model: mockModel({
    provider: 'orvo-deterministic-router',
    modelId: 'task-dispatch-v1',
    respond: ({ lastUserMessage, toolResults }) => {
      if (toolResults.length > 0) return 'Исполнение задания завершило текущий этап.';
      const taskId = lastUserMessage?.match(/"taskId"\s*:\s*"([a-zA-Z0-9_-]+)"/)?.[1];
      const input = { taskId };
      if (!input.taskId) return 'Не указан идентификатор задания.';
      return { toolCalls: [{ name: 'run_task', input: { taskId: input.taskId } }] };
    },
  }),
  defaultTools: false,
  modelContextWindowTokens: 1000000,
  tool: false,
  experimental: { workflow: { retention: 'default' } },
});
