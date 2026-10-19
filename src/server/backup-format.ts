import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('ORVOBK01');
const MAX_MANIFEST = 2 * 1024 * 1024;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 500;
const HEX_SHA = /^[a-f0-9]{64}$/;

export type BackupAttachment = { id: string; workspaceId: string; name: string; mime: string; storage: 'local' | 's3' | 'blob'; key: string; size: number; sha256: string };
export type BackupManifest = {
  version: 1;
  backupId: string;
  createdAt: string;
  source: { database: string; serverVersionNum: number; blobStoreId?: string };
  database: { format: 'pg-custom' | 'pglite-logical'; size: number; sha256: string };
  migrations: string[];
  attachments: BackupAttachment[];
};
export type StagedBackup = { manifest: BackupManifest; directory: string; databasePath: string; openAttachment: (index: number) => Readable; dispose: () => Promise<void> };

export function backupKey(value = process.env.ORVO_BACKUP_KEY_B64): Buffer {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('ORVO_BACKUP_KEY_B64 must contain a base64-encoded 32-byte key.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('ORVO_BACKUP_KEY_B64 must contain a base64-encoded 32-byte key.');
  return key;
}

export async function fileDigest(file: string, maximum = Number.MAX_SAFE_INTEGER) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(file)) { size += (chunk as Buffer).length; if (size > maximum) throw new Error('Backup item exceeds its size limit.'); hash.update(chunk as Buffer); }
  return { size, sha256: hash.digest('hex') };
}

function validateManifest(value: unknown): asserts value is BackupManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid backup manifest.');
  const m = value as BackupManifest;
  if (m.version !== 1 || !/^[a-f0-9-]{36}$/i.test(m.backupId) || !Number.isFinite(Date.parse(m.createdAt)) || !m.source || typeof m.source.database !== 'string' || m.source.database.length > 200 || !Number.isInteger(m.source.serverVersionNum) || (m.source.blobStoreId !== undefined && !/^[A-Za-z0-9-]{4,100}$/.test(m.source.blobStoreId))) throw new Error('Invalid backup manifest.');
  if (!m.database || !['pg-custom', 'pglite-logical'].includes(m.database.format) || !Number.isSafeInteger(m.database.size) || m.database.size < 1 || !HEX_SHA.test(m.database.sha256)) throw new Error('Invalid database entry.');
  if (!Array.isArray(m.migrations) || m.migrations.some(x => typeof x !== 'string' || x.length > 150)) throw new Error('Invalid migration list.');
  if (!Array.isArray(m.attachments) || m.attachments.length > MAX_ATTACHMENTS) throw new Error('Too many backup attachments.');
  const ids = new Set<string>();
  for (const a of m.attachments) {
    if (!a || !/^[a-f0-9-]{36}$/i.test(a.id) || !/^[A-Za-z0-9_-]{1,80}$/.test(a.workspaceId) || typeof a.name !== 'string' || !/\.(txt|md|pdf)$/i.test(a.name) || typeof a.key !== 'string' || a.key.length > 500 || !['local', 's3', 'blob'].includes(a.storage) || !['text/plain', 'application/pdf'].includes(a.mime) || !Number.isInteger(a.size) || a.size < 1 || a.size > MAX_ATTACHMENT || !HEX_SHA.test(a.sha256) || ids.has(a.id)) throw new Error('Invalid attachment entry.');
    ids.add(a.id);
  }
}

export async function encryptBackup(output: string, manifest: BackupManifest, databasePath: string, attachmentPaths: string[], key: Buffer) {
  validateManifest(manifest);
  if (key.length !== 32 || manifest.attachments.length !== attachmentPaths.length) throw new Error('Invalid backup inputs.');
  const database = await fileDigest(databasePath);
  if (database.size !== manifest.database.size || database.sha256 !== manifest.database.sha256) throw new Error('Database changed during backup.');
  for (let i = 0; i < attachmentPaths.length; i++) {
    const digest = await fileDigest(attachmentPaths[i]!, MAX_ATTACHMENT);
    if (digest.size !== manifest.attachments[i]!.size || digest.sha256 !== manifest.attachments[i]!.sha256) throw new Error('Attachment changed during backup.');
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (manifestBytes.length > MAX_MANIFEST) throw new Error('Backup manifest is too large.');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const header = Buffer.concat([MAGIC, nonce]);
  await writeFile(output, header, { flag: 'wx', mode: 0o600 });
  async function* contents() {
    const length = Buffer.alloc(4); length.writeUInt32BE(manifestBytes.length); yield length; yield manifestBytes;
    for (const file of [databasePath, ...attachmentPaths]) for await (const chunk of createReadStream(file)) yield chunk as Buffer;
  }
  try {
    await pipeline(Readable.from(contents()), cipher, createWriteStream(output, { flags: 'a', mode: 0o600 }));
    await appendFile(output, cipher.getAuthTag());
  } catch (error) { await rm(output, { force: true }); throw error; }
}

async function extractRange(source: string, destination: string, offset: number, size: number, expectedHash: string) {
  if (!Number.isSafeInteger(offset) || size < 1) throw new Error('Invalid backup item length.');
  await pipeline(createReadStream(source, { start: offset, end: offset + size - 1 }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  const digest = await fileDigest(destination, size);
  if (digest.size !== size || digest.sha256 !== expectedHash) throw new Error('Backup checksum mismatch.');
}

async function verifyRange(source: string, offset: number, size: number, expectedHash: string) {
  if (!Number.isSafeInteger(offset) || size < 1) throw new Error('Invalid backup item length.');
  const hash = createHash('sha256'); let actual = 0;
  for await (const chunk of createReadStream(source, { start: offset, end: offset + size - 1 })) {
    actual += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  if (actual !== size || hash.digest('hex') !== expectedHash) throw new Error('Backup checksum mismatch.');
}

export async function verifyBackup(archivePath: string, key: Buffer): Promise<StagedBackup> {
  if (key.length !== 32) throw new Error('Invalid backup key.');
  const directory = await mkdtemp(path.join(tmpdir(), 'orvo-restore-'));
  await mkdir(directory, { mode: 0o700, recursive: true });
  try {
    const archive = await stat(archivePath);
    if (archive.size < MAGIC.length + 12 + 16 + 4) throw new Error('Backup archive is truncated.');
    const handle = await open(archivePath, 'r');
    let prefix: Buffer; let tag: Buffer;
    try {
      prefix = Buffer.alloc(20); tag = Buffer.alloc(16);
      if ((await handle.read(prefix, 0, 20, 0)).bytesRead !== 20 || (await handle.read(tag, 0, 16, archive.size - 16)).bytesRead !== 16) throw new Error('Backup archive is truncated.');
    } finally { await handle.close(); }
    if (!prefix.subarray(0, 8).equals(MAGIC)) throw new Error('Unsupported backup archive.');
    const decipher = createDecipheriv('aes-256-gcm', key, prefix.subarray(8, 20));
    decipher.setAuthTag(tag);
    const plain = path.join(directory, 'verified.bin');
    await pipeline(createReadStream(archivePath, { start: 20, end: archive.size - 17 }), decipher, createWriteStream(plain, { flags: 'wx', mode: 0o600 }));
    const plainStat = await stat(plain);
    const plainHandle = await open(plain, 'r');
    let manifestBytes: Buffer;
    try {
      const lengthBytes = Buffer.alloc(4);
      if ((await plainHandle.read(lengthBytes, 0, 4, 0)).bytesRead !== 4) throw new Error('Backup manifest is missing.');
      const length = lengthBytes.readUInt32BE();
      if (length < 1 || length > MAX_MANIFEST || length > plainStat.size - 4) throw new Error('Invalid backup manifest length.');
      manifestBytes = Buffer.alloc(length);
      if ((await plainHandle.read(manifestBytes, 0, length, 4)).bytesRead !== length) throw new Error('Backup manifest is truncated.');
    } finally { await plainHandle.close(); }
    let parsed: unknown;
    try { parsed = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('Invalid backup manifest JSON.'); }
    validateManifest(parsed);
    const manifest = parsed;
    const expected = 4 + manifestBytes.length + manifest.database.size + manifest.attachments.reduce((sum, item) => sum + item.size, 0);
    if (expected !== plainStat.size) throw new Error('Backup archive length mismatch.');
    let offset = 4 + manifestBytes.length;
    const databasePath = path.join(directory, 'database.dump');
    await extractRange(plain, databasePath, offset, manifest.database.size, manifest.database.sha256);
    offset += manifest.database.size;
    const attachmentRanges: { offset: number; size: number }[] = [];
    for (let i = 0; i < manifest.attachments.length; i++) {
      const entry = manifest.attachments[i]!;
      await verifyRange(plain, offset, entry.size, entry.sha256);
      attachmentRanges.push({ offset, size: entry.size }); offset += entry.size;
    }
    return {
      manifest, directory, databasePath,
      openAttachment(index: number) {
        const range = attachmentRanges[index];
        if (!range) throw new Error('Invalid attachment index.');
        return createReadStream(plain, { start: range.offset, end: range.offset + range.size - 1 });
      },
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
