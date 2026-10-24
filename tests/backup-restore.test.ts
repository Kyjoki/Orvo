import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { backupKey, encryptBackup, fileDigest, verifyBackup, type BackupManifest } from '../src/server/backup-format';
import { assertRestoreTarget, quarantineSql, reconcileTargetBlobObjects, restoreAttachmentFiles, restoreLogicalFixture } from '../src/server/backup-restore';

test('encrypted archive rejects tampering and restores isolated PGlite data with execution quarantined', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orvo-backup-test-'));
  const source = new PGlite(); const target = new PGlite(); const atomicTarget = new PGlite();
  const previousTest = process.env.ORVO_TEST_MODE;
  process.env.ORVO_TEST_MODE = '1';
  delete process.env.VERCEL;
  try {
    for (const file of (await readdir(path.join(process.cwd(), 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(path.join(process.cwd(), 'migrations', file), 'utf8');
      await source.exec(sql); await target.exec(sql); await atomicTarget.exec(sql);
    }
    const authSchema = 'CREATE TABLE "user"(id text PRIMARY KEY,email text);CREATE TABLE "account"(id text PRIMARY KEY,user_id text,password text);CREATE TABLE "twoFactor"(id text PRIMARY KEY,secret text);CREATE TABLE "session"(id text PRIMARY KEY,user_id text);CREATE TABLE "verification"(id text PRIMARY KEY,token text);';
    await source.exec(authSchema); await target.exec(authSchema); await atomicTarget.exec(authSchema);
    const workspace = 'orvo-personal', agent = randomUUID(), task = randomUUID(), attachment = randomUUID(), usage = randomUUID(), control = randomUUID();
    const content = Buffer.from('# Accepted source attachment\n' + 'Restored bytes remain unchanged.');
    const oldKey = `orvo/${workspace}/${attachment}/sealed.md`;
    await source.query('INSERT INTO workspaces(id,name,settings) VALUES($1,$2,$3)', [workspace, 'Orvo', JSON.stringify({ modelChecked: true, checkedModels: ['live-model'] })]);
    const owner=`owner-${randomUUID()}`;
    await source.query('INSERT INTO owners(id,workspace_id,email) VALUES($1,$2,$3)',[owner,workspace,`${owner}@example.test`]);
    await source.query('INSERT INTO workspace_owners(owner_id,workspace_id) VALUES($1,$2)',[owner,workspace]);
    await source.query('INSERT INTO agents(id,workspace_id,role_key,data) VALUES($1,$2,$3,$4)', [agent, workspace, 'writer', JSON.stringify({ name: 'Writer' })]);
    await source.query('INSERT INTO tasks(id,workspace_id,agent_id,status,data,claimed) VALUES($1,$2,$3,$4,$5,true)', [task, workspace, agent, 'running', JSON.stringify({ workflowRunId: 'old-runtime', runtimeDispatchSentId: 'old-runtime', claimedOwner: 'old-runtime' })]);
    await source.query('INSERT INTO attachments(id,workspace_id,data) VALUES($1,$2,$3)', [attachment, workspace, JSON.stringify({ name: 'source.md', mime: 'text/plain', storage: 'blob', key: oldKey, status: 'ready', size: content.length })]);
    await source.query('INSERT INTO usage_entries(id,workspace_id,task_id,agent_id,state,reserved_tokens) VALUES($1,$2,$3,$4,$5,$6)', [usage, workspace, task, agent, 'reserved', 100]);
    await source.query('INSERT INTO runtime_controls(id,workspace_id,task_id,action,payload,state) VALUES($1,$2,$3,$4,$5,$6)', [control, workspace, task, 'resume', '{}', 'pending']);
    await source.query('INSERT INTO mfa_session_grants(session_id,user_id) VALUES($1,$2)', ['old-session', 'owner']);
    await source.query('INSERT INTO "user"(id,email) VALUES($1,$2)', ['owner', 'owner@example.test']);
    await source.query('INSERT INTO "account"(id,user_id,password) VALUES($1,$2,$3)', ['account', 'owner', 'synthetic-password-hash']);
    await source.query('INSERT INTO "twoFactor"(id,secret) VALUES($1,$2)', ['totp', 'synthetic-encrypted-secret']);
    await source.query('INSERT INTO "session"(id,user_id) VALUES($1,$2)', ['old-session', 'owner']);
    await source.query('INSERT INTO "verification"(id,token) VALUES($1,$2)', ['challenge', 'synthetic-challenge']);

    const tableNames = ['workspaces', 'owners', 'workspace_owners', 'agents', 'tasks', 'attachments', 'usage_entries', 'runtime_controls', 'mfa_session_grants', 'user', 'account', 'twoFactor', 'session', 'verification'];
    const fixture = { tables: [] as { name: string; rows: Record<string, unknown>[] }[] };
    for (const name of tableNames) fixture.tables.push({ name, rows: (await source.query<Record<string, unknown>>(`SELECT * FROM "${name}"`)).rows });
    const dbPath = path.join(root, 'fixture.json'), filePath = path.join(root, 'attachment.bin'), archive = path.join(root, 'backup.orvobak');
    await writeFile(dbPath, JSON.stringify(fixture)); await writeFile(filePath, content);
    const manifest: BackupManifest = { version: 1, backupId: randomUUID(), createdAt: new Date().toISOString(), source: { database: 'source.example/orvo', serverVersionNum: 170000, blobStoreId: 'source-store' }, database: { format: 'pglite-logical', ...await fileDigest(dbPath) }, migrations: [], attachments: [{ id: attachment, workspaceId: workspace, name: 'source.md', mime: 'text/plain', storage: 'blob', key: oldKey, ...await fileDigest(filePath) }] };
    const key = backupKey(randomBytes(32).toString('base64'));
    await encryptBackup(archive, manifest, dbPath, [filePath], key);
    const raw = await readFile(archive);
    assert.equal(raw.includes(content), false);
    await assert.rejects(verifyBackup(archive, randomBytes(32)));
    const corrupted = path.join(root, 'corrupt.orvobak'); const altered = Buffer.from(raw); altered[30] ^= 1; await writeFile(corrupted, altered);
    await assert.rejects(verifyBackup(corrupted, key));

    const staged = await verifyBackup(archive, key);
    try {
      const restoredFiles = new Map<string, Buffer>();
      await restoreAttachmentFiles(staged, async (pathname, body) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        restoredFiles.set(pathname, Buffer.concat(chunks));
      });
      await restoreLogicalFixture(target, staged);
      await restoreLogicalFixture(atomicTarget, staged, false);
      await atomicTarget.exec(`BEGIN;${quarantineSql(manifest)}COMMIT;`);
      assert.deepEqual(restoredFiles.get(oldKey), content);
      const rows = async (sql: string, params: unknown[] = []) => (await target.query<any>(sql, params)).rows;
      const restoredTask = (await rows('SELECT * FROM tasks WHERE id=$1', [task]))[0];
      assert.equal(restoredTask.status, 'paused'); assert.equal(restoredTask.claimed, false);
      assert.equal(restoredTask.data.workflowRunId, null); assert.equal(restoredTask.data.restoreQuarantine, true);
      assert.equal((await rows('SELECT state FROM usage_entries WHERE id=$1', [usage]))[0].state, 'unknown');
      assert.equal((await rows('SELECT state FROM runtime_controls WHERE id=$1', [control]))[0].state, 'consumed');
      assert.equal((await rows('SELECT count(*)::int AS count FROM "session"'))[0].count, 0);
      assert.equal((await rows('SELECT count(*)::int AS count FROM "verification"'))[0].count, 0);
      assert.equal((await rows('SELECT count(*)::int AS count FROM mfa_session_grants'))[0].count, 0);
      assert.equal((await rows('SELECT password FROM "account" WHERE id=$1', ['account']))[0].password, 'synthetic-password-hash');
      assert.equal((await rows('SELECT secret FROM "twoFactor" WHERE id=$1', ['totp']))[0].secret, 'synthetic-encrypted-secret');
      assert.deepEqual((await rows('SELECT settings FROM workspaces WHERE id=$1', [workspace]))[0].settings.checkedModels, []);
      assert.equal((await rows('SELECT data FROM attachments WHERE id=$1', [attachment]))[0].data.storage, 'blob');
      assert.equal((await atomicTarget.query<any>('SELECT status,claimed FROM tasks WHERE id=$1', [task])).rows[0].status, 'paused');
      assert.equal((await atomicTarget.query<any>('SELECT count(*)::int AS count FROM "session"')).rows[0].count, 0);
    } finally { await staged.dispose(); }
  } finally {
    if (previousTest === undefined) delete process.env.ORVO_TEST_MODE; else process.env.ORVO_TEST_MODE = previousTest;
    await source.close(); await target.close(); await atomicTarget.close();
    if (!root.startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('Unsafe temporary cleanup target.');
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic quarantine SQL escapes manifest data and never controls its own transaction', () => {
  const manifest: BackupManifest = { version: 1, backupId: randomUUID(), createdAt: new Date().toISOString(), source: { database: 'source.example/orvo', serverVersionNum: 180000 }, database: { format: 'pg-custom', size: 1, sha256: 'a'.repeat(64) }, migrations: [], attachments: [{ id: randomUUID(), workspaceId: 'orvo-personal', name: "attack'$orvo_restore_0$.md", mime: 'text/plain', storage: 's3', key: "old'key", size: 2, sha256: 'b'.repeat(64) }] };
  const sql = quarantineSql(manifest);
  assert.match(sql, /DO \$orvo_restore_1\$/);
  assert.match(sql, /old''key/);
  assert.match(sql, /DELETE FROM public\."session"/);
  assert.doesNotMatch(sql, /^(?:BEGIN|COMMIT);/m);
});

test('restore retry accepts only exact, checksum-verified Blob subset', async () => {
  const content = Buffer.from('restored bytes');
  const id = randomUUID(), workspaceId = 'orvo-personal';
  const pathname = `orvo/${workspaceId}/${id}/sealed.md`;
  const manifest: BackupManifest = { version: 1, backupId: randomUUID(), createdAt: new Date().toISOString(), source: { database: 'source.example/orvo', serverVersionNum: 180000 }, database: { format: 'pg-custom', size: 1, sha256: 'a'.repeat(64) }, migrations: [], attachments: [{ id, workspaceId, name: 'test.md', mime: 'text/plain', storage: 'blob', key: pathname, size: content.length, sha256: (await import('node:crypto')).createHash('sha256').update(content).digest('hex') }] };
  const staged = { manifest, openAttachment: () => Readable.from([content]) } as any;
  const objects = new Map<string, Buffer>(); let puts = 0;
  const client = {
    list: async () => ({ blobs: [...objects.keys()].map(pathname => ({ pathname })), hasMore: false, cursor: undefined }),
    get: async (pathname: string) => ({ statusCode: 200, stream: Readable.toWeb(Readable.from([objects.get(pathname)!])) }),
    put: async (pathname: string, body: Readable) => { const chunks: Buffer[] = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); objects.set(pathname, Buffer.concat(chunks)); puts++; },
  } as any;
  await reconcileTargetBlobObjects(staged, 'synthetic-token', client);
  await reconcileTargetBlobObjects(staged, 'synthetic-token', client);
  assert.equal(puts, 1);
  objects.set(pathname, Buffer.from('wrong bytes'));
  await assert.rejects(reconcileTargetBlobObjects(staged, 'synthetic-token', client), /differs from archive/);
  objects.set(pathname, content); objects.set('foreign/path', Buffer.from('foreign'));
  await assert.rejects(reconcileTargetBlobObjects(staged, 'synthetic-token', client), /unrelated object/);
  assert.equal(puts, 1);
});

test('restore rejects source or live database aliases and reused stores before any writes', () => {
  const manifest: BackupManifest = { version: 1, backupId: randomUUID(), createdAt: new Date().toISOString(), source: { database: 'db.example/orvo', serverVersionNum: 170000, blobStoreId: 'source' }, database: { format: 'pg-custom', size: 1, sha256: 'a'.repeat(64) }, migrations: [], attachments: [] };
  const oldAck = process.env.ORVO_RESTORE_ACK, oldSecret = process.env.ORVO_RESTORE_TARGET_RUNTIME_SECRET;
  process.env.ORVO_RESTORE_ACK = 'EMPTY_ISOLATED_TARGET'; process.env.ORVO_RESTORE_TARGET_RUNTIME_SECRET = 'new-isolated-runtime-secret-at-least-32-chars';
  try {
    assert.throws(() => assertRestoreTarget(manifest, 'postgres://user:newpass@db.example/orvo', 'vercel_blob_rw_target_secret'), /source or live database/);
    assert.throws(() => assertRestoreTarget(manifest, 'postgres://user:pass@scratch.example/orvo', 'vercel_blob_rw_source_secret'), /file store/);
  } finally { process.env.ORVO_RESTORE_ACK = oldAck; process.env.ORVO_RESTORE_TARGET_RUNTIME_SECRET = oldSecret; }
});
