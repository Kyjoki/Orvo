import { createWriteStream } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Client } from 'pg';
import { get, list, put } from '@vercel/blob';
import { blobPath } from './blob-storage';
import { backupKey, verifyBackup, type BackupManifest, type StagedBackup } from './backup-format';
import { blobStoreId, databaseIdentity, runPgTool, verifiedDatabaseUrl } from './backup';

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

async function hasTable(db: Queryable, name: string) {
  return !!(await db.query('SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', ['public', name])).rows.length;
}
async function hasColumn(db: Queryable, table: string, column: string) {
  return !!(await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3', ['public', table, column])).rows.length;
}

export async function quarantineRestoredDatabase(db: Queryable, manifest: BackupManifest) {
  await db.query('BEGIN');
  try {
    const ready = (await db.query("SELECT id,workspace_id,data FROM attachments WHERE data->>'status'='ready' ORDER BY id")).rows;
    const expected = new Map(manifest.attachments.map(item => [item.id, item]));
    if (ready.length !== expected.size) throw new Error('Restored attachment metadata does not match the archive.');
    for (const row of ready) {
      const item = expected.get(row.id);
      if (!item || row.workspace_id !== item.workspaceId || row.data.size !== item.size || row.data.key !== item.key) throw new Error('Restored attachment metadata does not match the archive.');
      const key = blobPath(item.workspaceId, item.id, item.name, 'sealed');
      await db.query('UPDATE attachments SET data=data || $3::jsonb WHERE id=$1 AND workspace_id=$2', [item.id, item.workspaceId, JSON.stringify({ storage: 'blob', key, test: false })]);
    }
    await db.query("UPDATE attachments SET data=data || $1::jsonb WHERE data->>'status'='uploading'", [JSON.stringify({ status: 'error', error: 'Загрузка прервана восстановлением.', cleanupState: 'done' })]);
    await db.query("UPDATE tasks SET status='paused',claimed=false,data=data || $1::jsonb WHERE status NOT IN ('completed','cancelled','failed')", [JSON.stringify({ restoreQuarantine: true, restoreBackupId: manifest.backupId, restoreReviewRequired: true, workflowRunId: null, runtimeDispatchSentId: null, claimedOwner: null })]);
    await db.query('UPDATE tasks SET claimed=false WHERE claimed=true');
    if (await hasColumn(db, 'tasks', 'dispatch_lease_token')) await db.query('UPDATE tasks SET dispatch_lease_token=NULL,dispatch_lease_until=NULL');
    if (await hasTable(db, 'usage_entries')) await db.query("UPDATE usage_entries SET state='unknown',data=data || $1::jsonb WHERE state='reserved'", [JSON.stringify({ usageKnown: false, restoreBackupId: manifest.backupId })]);
    if (await hasTable(db, 'model_checks')) await db.query("UPDATE model_checks SET state='unknown' WHERE state='reserved'");
    if (await hasTable(db, 'runtime_controls')) await db.query("UPDATE runtime_controls SET state='consumed',lease_token=NULL,lease_until=NULL WHERE state IN ('pending','leased')");
    if (await hasTable(db, 'approvals')) await db.query("UPDATE approvals SET state='revoked',version=version+1 WHERE state='pending'");
    if (await hasTable(db, 'workspaces')) await db.query('UPDATE workspaces SET settings=settings || $1::jsonb', [JSON.stringify({ modelChecked: false, checkedModels: [], modelCheckError: 'Проверьте модель после восстановления.' })]);
    // Sessions and verification challenges are invalid across environments.
    // Preserve user/account/TOTP credentials and encrypted recovery codes.
    for (const table of ['session', 'verification', 'mfa_session_grants', 'mfa_totp_replay']) if (await hasTable(db, table)) await db.query(`DELETE FROM "${table}"`);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}

export async function restoreAttachmentFiles(staged: StagedBackup, write: (pathname: string, body: Readable, mime: string) => Promise<void>) {
  for (let i = 0; i < staged.manifest.attachments.length; i++) {
    const attachment = staged.manifest.attachments[i]!;
    await write(blobPath(attachment.workspaceId, attachment.id, attachment.name, 'sealed'), staged.openAttachment(i), attachment.mime);
  }
}

function sqlLiteral(value: string) { return `'${value.replace(/'/g, "''")}'`; }

export function quarantineSql(manifest: BackupManifest) {
  const expected = manifest.attachments.map(a => ({ id: a.id, workspace_id: a.workspaceId, key: a.key, size: a.size, name: a.name, mime: a.mime, target_key: blobPath(a.workspaceId, a.id, a.name, 'sealed') }));
  const json = sqlLiteral(JSON.stringify(expected));
  const taskPatch = sqlLiteral(JSON.stringify({ restoreQuarantine: true, restoreBackupId: manifest.backupId, restoreReviewRequired: true, workflowRunId: null, runtimeDispatchSentId: null, claimedOwner: null }));
  const usagePatch = sqlLiteral(JSON.stringify({ usageKnown: false, restoreBackupId: manifest.backupId }));
  const filePatch = sqlLiteral(JSON.stringify({ status: 'error', error: 'Загрузка прервана восстановлением.', cleanupState: 'done' }));
  const workspacePatch = sqlLiteral(JSON.stringify({ modelChecked: false, checkedModels: [], modelCheckError: 'Проверьте модель после восстановления.' }));
  const embedded = [json, taskPatch, usagePatch, filePatch, workspacePatch].join('');
  let tagIndex = 0;
  let tag = '$orvo_restore_0$';
  while (embedded.includes(tag)) tag = `$orvo_restore_${++tagIndex}$`;
  return `
-- Quarantine and validation run in the SAME psql --single-transaction as the restore.
DO ${tag}
DECLARE expected jsonb := ${json}::jsonb;
BEGIN
  IF (SELECT count(*) FROM public.attachments WHERE data->>'status'='ready') <> jsonb_array_length(expected)
     OR EXISTS (
       SELECT 1 FROM jsonb_to_recordset(expected) AS e(id text,workspace_id text,key text,size integer,name text,mime text,target_key text)
       LEFT JOIN public.attachments a ON a.id=e.id AND a.workspace_id=e.workspace_id
       WHERE a.id IS NULL OR a.data->>'key' IS DISTINCT FROM e.key
         OR a.data->>'size' IS DISTINCT FROM e.size::text
         OR a.data->>'name' IS DISTINCT FROM e.name
         OR a.data->>'mime' IS DISTINCT FROM e.mime
     ) THEN RAISE EXCEPTION 'Restored attachment metadata does not match the archive'; END IF;
END ${tag};
UPDATE public.attachments a SET data=a.data || jsonb_build_object('storage','blob','key',e.target_key,'test',false)
  FROM jsonb_to_recordset(${json}::jsonb) AS e(id text,workspace_id text,key text,size integer,name text,mime text,target_key text)
  WHERE a.id=e.id AND a.workspace_id=e.workspace_id AND a.data->>'status'='ready';
UPDATE public.attachments SET data=data || ${filePatch}::jsonb WHERE data->>'status'='uploading';
UPDATE public.tasks SET status='paused',claimed=false,data=data || ${taskPatch}::jsonb WHERE status NOT IN ('completed','cancelled','failed');
UPDATE public.tasks SET claimed=false WHERE claimed=true;
DO ${tag}
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks' AND column_name='dispatch_lease_token') THEN
    UPDATE public.tasks SET dispatch_lease_token=NULL,dispatch_lease_until=NULL;
  END IF;
  IF to_regclass('public.usage_entries') IS NOT NULL THEN
    UPDATE public.usage_entries SET state='unknown',data=data || ${usagePatch}::jsonb WHERE state='reserved';
  END IF;
  IF to_regclass('public.model_checks') IS NOT NULL THEN
    UPDATE public.model_checks SET state='unknown' WHERE state='reserved';
  END IF;
  IF to_regclass('public.runtime_controls') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='runtime_controls' AND column_name='lease_token') THEN
      UPDATE public.runtime_controls SET state='consumed',lease_token=NULL,lease_until=NULL WHERE state IN ('pending','leased');
    ELSE
      UPDATE public.runtime_controls SET state='consumed' WHERE state='pending';
    END IF;
  END IF;
  IF to_regclass('public.approvals') IS NOT NULL THEN
    UPDATE public.approvals SET state='revoked',version=version+1 WHERE state='pending';
  END IF;
  UPDATE public.workspaces SET settings=settings || ${workspacePatch}::jsonb;
  IF to_regclass('public.session') IS NOT NULL THEN DELETE FROM public."session"; END IF;
  IF to_regclass('public.verification') IS NOT NULL THEN DELETE FROM public."verification"; END IF;
  IF to_regclass('public.mfa_session_grants') IS NOT NULL THEN DELETE FROM public.mfa_session_grants; END IF;
  IF to_regclass('public.mfa_totp_replay') IS NOT NULL THEN DELETE FROM public.mfa_totp_replay; END IF;
END ${tag};
`;
}

export async function reconcileTargetBlobObjects(staged: StagedBackup, token: string, client: Pick<{ list: typeof list; get: typeof get; put: typeof put }, 'list' | 'get' | 'put'> = { list, get, put }) {
  const expected = new Map(staged.manifest.attachments.map((a, index) => [blobPath(a.workspaceId, a.id, a.name, 'sealed'), { attachment: a, index }]));
  const existing = new Set<string>(); let cursor: string | undefined; let pages = 0;
  do {
    if (++pages > 10) throw new Error('Restore file store has too many objects.');
    const page = await client.list({ token, limit: 100, cursor });
    for (const item of page.blobs) {
      if (!expected.has(item.pathname) || existing.has(item.pathname)) throw new Error('Restore file store contains an unrelated object.');
      existing.add(item.pathname);
    }
    if (page.hasMore && !page.cursor) throw new Error('Restore file store listing is incomplete.');
    cursor = page.cursor || undefined;
  } while (cursor);
  for (const [pathname, entry] of expected) {
    if (existing.has(pathname)) {
      const response = await client.get(pathname, { access: 'private', token, useCache: false });
      if (!response || response.statusCode !== 200) throw new Error('Existing restore object is unavailable.');
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of Readable.fromWeb(response.stream as any)) {
        size += (chunk as Buffer).length;
        if (size > entry.attachment.size) throw new Error('Existing restore object differs from archive.');
        hash.update(chunk as Buffer);
      }
      if (size !== entry.attachment.size || hash.digest('hex') !== entry.attachment.sha256) throw new Error('Existing restore object differs from archive.');
    }
  }
  for (const [pathname, entry] of expected) if (!existing.has(pathname)) {
    await client.put(pathname, staged.openAttachment(entry.index), { token, access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: entry.attachment.mime });
  }
}

// The isolated PGlite fixture path tests import, constraints, and quarantine
// without requiring pg_dump binaries or any production credentials.
export async function restoreLogicalFixture(db: Queryable, staged: StagedBackup, quarantine = true) {
  if (process.env.ORVO_TEST_MODE !== '1' || process.env.VERCEL || staged.manifest.database.format !== 'pglite-logical') throw new Error('Logical restore is only available in isolated test mode.');
  const fixture = JSON.parse(await readFile(staged.databasePath, 'utf8')) as { tables?: { name: string; rows: Record<string, unknown>[] }[] };
  const allowed = new Set(['workspaces', 'owners', 'workspace_owners', 'agents', 'tasks', 'attachments', 'usage_entries', 'runtime_controls', 'approvals', 'model_checks', 'mfa_session_grants', 'mfa_totp_replay', 'user', 'account', 'twoFactor', 'session', 'verification']);
  if (!Array.isArray(fixture.tables) || fixture.tables.length > allowed.size) throw new Error('Invalid logical fixture.');
  await db.query('BEGIN');
  try {
    for (const table of fixture.tables) {
      if (!allowed.has(table.name) || !Array.isArray(table.rows) || table.rows.length > 1000) throw new Error('Invalid logical fixture table.');
      for (const row of table.rows) {
        const columns = Object.keys(row);
        if (!columns.length || columns.some(column => !/^[a-z_][a-z0-9_]*$/i.test(column))) throw new Error('Invalid logical fixture column.');
        const values = columns.map(column => typeof row[column] === 'object' && row[column] !== null ? JSON.stringify(row[column]) : row[column]);
        await db.query(`INSERT INTO "${table.name}"(${columns.map(column => `"${column}"`).join(',')}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')})`, values);
      }
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  if (quarantine) await quarantineRestoredDatabase(db, staged.manifest);
}

export function assertRestoreTarget(manifest: BackupManifest, targetUrl: string, targetBlobToken: string) {
  if (process.env.ORVO_RESTORE_ACK !== 'EMPTY_ISOLATED_TARGET') throw new Error('Restore acknowledgement is required.');
  const target = databaseIdentity(targetUrl);
  const liveUrl = process.env.DATABASE_URL;
  const sourceUrl = process.env.ORVO_BACKUP_SOURCE_DATABASE_URL;
  if (target === manifest.source.database || (liveUrl && target === databaseIdentity(liveUrl, false)) || (sourceUrl && target === databaseIdentity(sourceUrl, false))) throw new Error('Restore target matches a source or live database.');
  const store = blobStoreId(targetBlobToken);
  if (store === manifest.source.blobStoreId || (process.env.ORVO_BACKUP_SOURCE_BLOB_TOKEN && store === blobStoreId(process.env.ORVO_BACKUP_SOURCE_BLOB_TOKEN)) || (process.env.ORVO_BACKUP_BLOB_TOKEN && store === blobStoreId(process.env.ORVO_BACKUP_BLOB_TOKEN))) throw new Error('Restore file store must be separate from source and backup stores.');
  const runtimeSecret = process.env.ORVO_RESTORE_TARGET_RUNTIME_SECRET;
  if (!runtimeSecret || runtimeSecret.length < 32 || (process.env.ORVO_RUNTIME_SECRET && runtimeSecret === process.env.ORVO_RUNTIME_SECRET)) throw new Error('A new target runtime secret is required.');
}

export async function assertEmptyRestoreTargets(targetUrl: string, _targetBlobToken: string) {
  const db = new Client({ connectionString: verifiedDatabaseUrl(targetUrl) });
  await db.connect();
  try {
    const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' LIMIT 1")).rows;
    if (tables.length) throw new Error('Restore database is not empty.');
  } finally { await db.end(); }
}

export async function applyVerifiedBackup(staged: StagedBackup) {
  if (staged.manifest.database.format !== 'pg-custom') throw new Error('Only pg_dump custom archives can be restored to PostgreSQL.');
  const targetUrl = process.env.ORVO_RESTORE_TARGET_DATABASE_URL;
  const targetBlobToken = process.env.ORVO_RESTORE_TARGET_BLOB_TOKEN;
  if (!targetUrl || !targetBlobToken) throw new Error('Restore target database and private Blob store are required.');
  assertRestoreTarget(staged.manifest, targetUrl, targetBlobToken);
  await assertEmptyRestoreTargets(targetUrl, targetBlobToken);
  const tool = process.env.PG_RESTORE_BIN || 'pg_restore';
  const version = await runPgTool(tool, ['--version']);
  const major = Number(/(?:PostgreSQL\)\s*)(\d+)/i.exec(version)?.[1]);
  if (!Number.isInteger(major) || major < Math.floor(staged.manifest.source.serverVersionNum / 10000)) throw new Error('pg_restore is older than the backup database.');
  const psql = process.env.PG_PSQL_BIN || 'psql';
  const psqlVersion = await runPgTool(psql, ['--version']);
  const psqlMajor = Number(/(?:PostgreSQL\)\s*)(\d+)/i.exec(psqlVersion)?.[1]);
  if (!Number.isInteger(psqlMajor) || psqlMajor < Math.floor(staged.manifest.source.serverVersionNum / 10000)) throw new Error('psql is older than the backup database.');
  const sqlPath = path.join(staged.directory, 'restore.sql');
  await runPgTool(tool, ['--no-owner', '--no-privileges', '--file', sqlPath, staged.databasePath]);
  await appendFile(sqlPath, quarantineSql(staged.manifest));
  // A crash during pg_restore/psql leaves an empty target database. On retry,
  // only exact, checksum-verified objects from this archive may already exist.
  await reconcileTargetBlobObjects(staged, targetBlobToken);
  await runPgTool(psql, ['-X', '--set', 'ON_ERROR_STOP=1', '--single-transaction', '--file', sqlPath], targetUrl);
  return { backupId: staged.manifest.backupId, attachments: staged.manifest.attachments.length, tasksQuarantined: true, sessionsRevoked: true };
}

export async function inspectBackup(archivePath: string) {
  const staged = await verifyBackup(archivePath, backupKey());
  try { return { backupId: staged.manifest.backupId, createdAt: staged.manifest.createdAt, databaseFormat: staged.manifest.database.format, attachments: staged.manifest.attachments.length, migrations: staged.manifest.migrations.length, verified: true }; }
  finally { await staged.dispose(); }
}

export async function restoreBackup(archivePath: string) {
  const staged = await verifyBackup(archivePath, backupKey());
  try { return await applyVerifiedBackup(staged); }
  finally { await staged.dispose(); }
}

export async function downloadEncryptedBackup(pathname: string, output: string) {
  if (!/^orvo-backups\/[a-f0-9-]{36}\.orvobak$/i.test(pathname) || !process.env.ORVO_BACKUP_BLOB_TOKEN) throw new Error('Invalid backup object request.');
  const result = await get(pathname, { access: 'private', token: process.env.ORVO_BACKUP_BLOB_TOKEN, useCache: false });
  if (!result || result.statusCode !== 200) throw new Error('Backup object is missing.');
  await pipeline(Readable.fromWeb(result.stream as any), createWriteStream(output, { flags: 'wx', mode: 0o600 }));
}
