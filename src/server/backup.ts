import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client } from 'pg';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { get, put, list, del } from '@vercel/blob';
import { blobPath } from './blob-storage';
import { backupKey, encryptBackup, fileDigest, type BackupAttachment, type BackupManifest } from './backup-format';

const MAX_ATTACHMENT = 10 * 1024 * 1024;

export function databaseIdentity(value: string, requireDirect = true) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || (requireDirect && /-pooler\./i.test(url.hostname))) throw new Error('Backup requires a direct PostgreSQL URL.');
  return `${url.hostname.toLowerCase().replace(/-pooler(?=\.)/i, '')}/${decodeURIComponent(url.pathname.slice(1))}`;
}

export function verifiedDatabaseUrl(value: string) {
  databaseIdentity(value);
  const url = new URL(value);
  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}

export function pgEnvironment(databaseUrl: string) {
  databaseIdentity(databaseUrl);
  const url = new URL(databaseUrl);
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: 'verify-full' };
}

export async function runPgTool(binary: string, args: string[], databaseUrl?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, { env: databaseUrl ? pgEnvironment(databaseUrl) : process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; let stderrBytes = 0;
    child.stdout.on('data', chunk => { if (output.length < 1024) output += String(chunk).slice(0, 1024 - output.length); });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
    child.once('error', () => reject(new Error(`${path.basename(binary)} is unavailable.`)));
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`${path.basename(binary)} failed (${code ?? 'unknown'}; diagnostics suppressed).`)));
  });
}

async function copyLimited(source: NodeJS.ReadableStream | ReadableStream<Uint8Array>, destination: string) {
  let size = 0;
  const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; if (size > MAX_ATTACHMENT) callback(new Error('Attachment exceeds 10 MiB.')); else callback(null, chunk); } });
  const readable = source instanceof Readable ? source : Readable.fromWeb(source as any);
  await pipeline(readable, limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
}

function rowStorage(data: any): 'local' | 's3' | 'blob' { return data.storage || (data.test ? 'local' : 's3'); }
function sourceS3() {
  if (!process.env.S3_BUCKET || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) throw new Error('S3 source credentials are missing.');
  return new S3Client({ region: process.env.S3_REGION || 'auto', endpoint: process.env.S3_ENDPOINT || undefined, forcePathStyle: !!process.env.S3_ENDPOINT, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
}
async function stageAttachment(row: any, destination: string) {
  const data = row.data; const storage = rowStorage(data);
  if (!Number.isInteger(data.size) || data.size < 1 || data.size > MAX_ATTACHMENT) throw new Error('Invalid source attachment size.');
  if (storage === 'blob') {
    if (!process.env.ORVO_BACKUP_SOURCE_BLOB_TOKEN || data.key !== blobPath(row.workspace_id, row.id, data.name, 'sealed')) throw new Error('Invalid source private Blob configuration.');
    const response = await get(data.key, { access: 'private', token: process.env.ORVO_BACKUP_SOURCE_BLOB_TOKEN, useCache: false });
    if (!response || response.statusCode !== 200) throw new Error('Source attachment is missing.');
    await copyLimited(response.stream, destination);
  } else if (storage === 's3') {
    if (typeof data.key !== 'string' || !data.key.startsWith(`${row.workspace_id}/sealed/`)) throw new Error('Invalid source S3 attachment key.');
    const response = await sourceS3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: data.key }));
    if (!response.Body) throw new Error('Source attachment is missing.');
    await copyLimited(response.Body as NodeJS.ReadableStream, destination);
  } else {
    if (process.env.ORVO_TEST_MODE !== '1' || process.env.VERCEL || !/^[a-f0-9-]{36}$/i.test(row.id)) throw new Error('Local attachment backup is only allowed in isolated test mode.');
    await copyLimited(createReadStream(path.join(process.cwd(), '.orvo', 'test-files', row.id)), destination);
  }
  const digest = await fileDigest(destination, MAX_ATTACHMENT);
  if (digest.size !== data.size) throw new Error('Source attachment size changed during backup.');
  return { id: row.id, workspaceId: row.workspace_id, name: data.name, mime: data.mime, storage, key: data.key, ...digest } satisfies BackupAttachment;
}

export function blobStoreId(token: string) {
  const parts = token.split('_');
  if (parts.length < 5 || !parts[3]) throw new Error('Invalid private Blob token.');
  return parts[3];
}
export function assertSeparateStores(backupToken: string, sourceToken?: string, targetToken?: string) {
  const backup = blobStoreId(backupToken);
  if (sourceToken && blobStoreId(sourceToken) === backup) throw new Error('Backup store must differ from source file store.');
  if (targetToken && blobStoreId(targetToken) === backup) throw new Error('Backup store must differ from restore file store.');
}

export async function uploadEncryptedBackup(archivePath: string, backupId: string, retentionDays = 14) {
  if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 365) throw new Error('Retention must be 7–365 days.');
  const token = process.env.ORVO_BACKUP_BLOB_TOKEN;
  if (!token) throw new Error('ORVO_BACKUP_BLOB_TOKEN is required for upload.');
  assertSeparateStores(token, process.env.ORVO_BACKUP_SOURCE_BLOB_TOKEN, process.env.ORVO_RESTORE_TARGET_BLOB_TOKEN);
  const pathname = `orvo-backups/${backupId}.orvobak`;
  await put(pathname, createReadStream(archivePath), { token, access: 'private', multipart: true, addRandomSuffix: false, allowOverwrite: false, contentType: 'application/octet-stream' });
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let cursor: string | undefined; let deleted = 0; let pages = 0;
  do {
    const page = await list({ token, prefix: 'orvo-backups/', limit: 100, cursor });
    for (const item of page.blobs) {
      if (deleted >= 50) break;
      if (item.pathname !== pathname && /^orvo-backups\/[a-f0-9-]{36}\.orvobak$/i.test(item.pathname) && new Date(item.uploadedAt).getTime() < cutoff) { await del(item.pathname, { token }); deleted++; }
    }
    if (deleted >= 50) break;
    cursor = page.cursor || undefined; pages++;
  } while (cursor && pages < 10);
  return { pathname, deleted };
}

export async function createBackup(output: string) {
  const key = backupKey();
  const sourceUrl = process.env.ORVO_BACKUP_SOURCE_DATABASE_URL;
  if (!sourceUrl) throw new Error('ORVO_BACKUP_SOURCE_DATABASE_URL is required.');
  const identity = databaseIdentity(sourceUrl);
  const temp = await mkdtemp(path.join(tmpdir(), 'orvo-backup-'));
  const client = new Client({ connectionString: verifiedDatabaseUrl(sourceUrl) });
  let connected = false; let inTransaction = false;
  try {
    await client.connect(); connected = true;
    const version = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
    const dumpBinary = process.env.PG_DUMP_BIN || 'pg_dump';
    const toolVersion = await runPgTool(dumpBinary, ['--version']);
    const toolMajor = Number(/(?:PostgreSQL\)\s*)(\d+)/i.exec(toolVersion)?.[1]);
    if (!Number.isInteger(toolMajor) || toolMajor < Math.floor(version / 10000)) throw new Error('pg_dump is older than the PostgreSQL server.');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); inTransaction = true;
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id as string;
    const rows = (await client.query("SELECT id,workspace_id,data FROM attachments WHERE data->>'status'='ready' ORDER BY id")).rows;
    if (rows.length > 500) throw new Error('More than 500 ready attachments; backup limit must be reviewed.');
    const migrations = (await client.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(row => String(row.name));
    const databasePath = path.join(temp, 'database.dump');
    await runPgTool(dumpBinary, ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`, '--file', databasePath], sourceUrl);
    await client.query('COMMIT'); inTransaction = false;
    const attachmentPaths: string[] = []; const attachments: BackupAttachment[] = [];
    for (let i = 0; i < rows.length; i++) {
      const staged = path.join(temp, `attachment-${String(i).padStart(4, '0')}.bin`);
      attachments.push(await stageAttachment(rows[i], staged)); attachmentPaths.push(staged);
    }
    const manifest: BackupManifest = { version: 1, backupId: randomUUID(), createdAt: new Date().toISOString(), source: { database: identity, serverVersionNum: version, ...(process.env.ORVO_BACKUP_SOURCE_BLOB_TOKEN ? { blobStoreId: blobStoreId(process.env.ORVO_BACKUP_SOURCE_BLOB_TOKEN) } : {}) }, database: { format: 'pg-custom', ...await fileDigest(databasePath) }, migrations, attachments };
    await encryptBackup(output, manifest, databasePath, attachmentPaths, key);
    return manifest;
  } finally {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    if (connected) await client.end().catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
}
