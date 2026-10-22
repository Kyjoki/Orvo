import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ORVO_TEST_MODE = '1';
delete process.env.DATABASE_URL;
delete process.env.ORVO_TEST_DB_DIR;
process.env.ORVO_TEST_DB_NAME = `watch-feedback-${process.pid}-${randomUUID().slice(0, 8)}`;
process.env.ORVO_WORKSPACE_ID = `watch-feedback-${process.pid}`;

const { getWorkspace } = await import('../src/server/domain');
const { getDatabase, query } = await import('../src/server/db');
const { addWatchFeedback, deleteWatchFeedback, listWatchFeedback, watchFeedbackInstructions } =
  await import('../src/server/watch-feedback');
const workspace = await getWorkspace();
after(async () => { const database = await getDatabase(); if (database.kind === 'pglite') await database.db.close(); });

test('owner examples are redacted, bounded, read back and removed', async () => {
  const created = await addWatchFeedback(workspace.id, {
    label: 'important', example: 'Срочно проверить терминал, звоните +7 777 123 45 67',
  });
  assert.match(created.example, /\[номер скрыт\]/);
  const examples = await listWatchFeedback(workspace.id);
  assert.equal(examples.length, 1);
  assert.equal(examples[0].id, created.id);
  assert.equal(JSON.stringify(examples).includes('777 123'), false);
  assert.match(await watchFeedbackInstructions(workspace.id), /Важный пример.*терминал/);
  assert.equal(await deleteWatchFeedback(workspace.id, created.id), true);
  assert.equal(await watchFeedbackInstructions(workspace.id), '');
});

test('feedback is scoped to the workspace and never retains a raw link', async () => {
  const created = await addWatchFeedback(workspace.id, {
    label: 'noise', example: 'Автоматический возврат завершён, подробности https://example.com/private',
  });
  const row = (await query<{ example: string }>(
    'SELECT example FROM watch_feedback WHERE workspace_id=$1 AND id=$2', [workspace.id, created.id],
  )).rows[0];
  assert.equal(row.example.includes('example.com'), false);
  assert.equal(await deleteWatchFeedback('another-workspace', created.id), false);
  assert.equal((await listWatchFeedback(workspace.id)).length, 1);
});

test('an older relevant example still reaches analysis after newer unrelated ratings', async () => {
  const relevant = await addWatchFeedback(workspace.id, {
    label: 'important', example: 'Терминал не принимает оплату, клиенты ждут',
  });
  for (const example of [
    'Нужно обновить фотографии блюд в меню',
    'Нужно проверить название группы ресторана',
    'Нужно назначить ответственного за дизайн',
  ]) await addWatchFeedback(workspace.id, { label: 'important', example });
  const instructions = await watchFeedbackInstructions(workspace.id, {
    chatTitle: 'Киоск', pinned: false, excerpts: ['Терминал перестал принимать оплату'],
  });
  assert.match(instructions, /Терминал не принимает оплату/);
  assert.equal((instructions.match(/Важный пример:/g) || []).length, 3);
  assert.equal(instructions.includes('https://'), false);
  await deleteWatchFeedback(workspace.id, relevant.id);
});
