import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBackup, uploadEncryptedBackup } from '../src/server/backup';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
for (const arg of args) if (!['--output', '--upload', '--retention-days'].includes(arg) && !args.some((item, index) => ['--output', '--retention-days'].includes(item) && args[index + 1] === arg)) throw new Error('Unknown backup option.');
const upload = args.includes('--upload');
const retention = Number(option('--retention-days') || '14');
if (!Number.isInteger(retention) || retention < 7 || retention > 365) throw new Error('Retention must be 7–365 days.');
if (upload && !process.env.ORVO_BACKUP_BLOB_TOKEN) throw new Error('ORVO_BACKUP_BLOB_TOKEN is required for upload.');
const output = path.resolve(option('--output') || path.join('.orvo', 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.orvobak`));
if (!output.endsWith('.orvobak')) throw new Error('Backup output must end in .orvobak.');
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
const manifest = await createBackup(output);
const uploaded = upload ? await uploadEncryptedBackup(output, manifest.backupId, retention) : null;
console.log(JSON.stringify({ ok: true, backupId: manifest.backupId, attachments: manifest.attachments.length, encrypted: true, uploaded: !!uploaded, retentionDays: retention, pruned: uploaded?.deleted || 0 }));
