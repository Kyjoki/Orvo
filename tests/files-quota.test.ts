import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ORVO_TEST_MODE = '1';
delete process.env.VERCEL;
delete process.env.DATABASE_URL;
delete process.env.ORVO_TEST_DB_DIR;
process.env.ORVO_TEST_DB_NAME = `files-quota-${process.pid}-${randomUUID().slice(0,8)}`;
process.env.ORVO_WORKSPACE_ID = `quota-${process.pid}`;

const { getWorkspace } = await import('../src/server/domain');
const { query, getDatabase } = await import('../src/server/db');
const { registerFile, cleanupStaleUploads } = await import('../src/server/files');
const workspace = await getWorkspace();
after(async () => { const database = await getDatabase(); if (database.kind === 'pglite') await database.db.close(); });

test('workspace lock reserves the final attachment slot once; expiry releases it and staging cleanup retains metadata', async () => {
  await query(`INSERT INTO attachments(id,workspace_id,task_id,data)
    SELECT 'seed-' || g::text,$1,NULL,'{"name":"old.txt","status":"ready"}'::jsonb
    FROM generate_series(1,499) AS g`, [workspace.id]);

  const results = await Promise.allSettled([
    registerFile(workspace.id, { name: 'one.md', size: 10 }),
    registerFile(workspace.id, { name: 'two.md', size: 10 }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && (result.reason as any).code === 'FILE_LIMIT').length, 1);
  const accepted = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>).value;
  const active = (await query(`SELECT count(*)::int AS count FROM attachments WHERE workspace_id=$1 AND
    (data->>'status'='ready' OR (data->>'status'='uploading' AND (data->>'expiresAt')::timestamptz > now()))`, [workspace.id])).rows[0].count;
  assert.equal(active, 500);

  await query(`UPDATE attachments SET data=data || $2::jsonb WHERE id=$1`, [accepted.id, JSON.stringify({ expiresAt: new Date(Date.now() - 10 * 60_000).toISOString() })]);
  const replacement = await registerFile(workspace.id, { name: 'replacement.md', size: 12 });
  assert.ok(replacement.id);
  const expired = (await query('SELECT data FROM attachments WHERE id=$1 AND workspace_id=$2', [accepted.id, workspace.id])).rows[0].data;
  assert.equal(expired.status, 'expired');
  assert.equal(expired.cleanupState, 'done');
  assert.match(expired.name, /^(one|two)\.md$/);
  assert.equal(await cleanupStaleUploads(workspace.id), 0);
  const afterCount = (await query('SELECT count(*)::int AS count FROM attachments WHERE workspace_id=$1', [workspace.id])).rows[0].count;
  assert.equal(afterCount, 501);
  const unsafeId = randomUUID();
  await query('INSERT INTO attachments(id,workspace_id,data) VALUES($1,$2,$3)', [unsafeId, workspace.id, JSON.stringify({ name: 'unsafe.md', storage: 'blob', key: 'orvo/another-space/foreign/staging.md', status: 'error' })]);
  assert.equal(await cleanupStaleUploads(workspace.id), 0);
  const unsafe = (await query('SELECT data FROM attachments WHERE id=$1', [unsafeId])).rows[0].data;
  assert.equal(unsafe.cleanupState, 'blocked');
  assert.equal(unsafe.status, 'error');
  const ready = (await query("SELECT data FROM attachments WHERE id='seed-1'")).rows[0].data;
  assert.equal(ready.status, 'ready');
  const pendingId = randomUUID();
  await query('INSERT INTO attachments(id,workspace_id,data) VALUES($1,$2,$3)', [pendingId, workspace.id, JSON.stringify({ name: 'pending.md', storage: 'local', key: `${workspace.id}/${pendingId}`, status: 'error', cleanupState: 'pending', error: 'upload permission failed' })]);
  assert.equal(await cleanupStaleUploads(workspace.id), 1);
  const pending = (await query('SELECT data FROM attachments WHERE id=$1', [pendingId])).rows[0].data;
  assert.equal(pending.cleanupState, 'done');
  assert.equal(pending.error, 'upload permission failed');
});
