import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadEncryptedBackup, inspectBackup, restoreBackup } from '../src/server/backup-restore';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
for (const arg of args) if (!['--archive', '--blob-path', '--dry-run', '--apply'].includes(arg) && !args.some((item, index) => ['--archive', '--blob-path'].includes(item) && args[index + 1] === arg)) throw new Error('Unknown restore option.');
if (args.includes('--apply') && args.includes('--dry-run')) throw new Error('Choose either --dry-run or --apply.');
if (!!option('--archive') === !!option('--blob-path')) throw new Error('Specify exactly one --archive or --blob-path.');
const temp = option('--blob-path') ? await mkdtemp(path.join(tmpdir(), 'orvo-archive-')) : null;
try {
  const archive = temp ? path.join(temp, 'download.orvobak') : path.resolve(option('--archive')!);
  if (temp) await downloadEncryptedBackup(option('--blob-path')!, archive);
  const result = args.includes('--apply') ? await restoreBackup(archive) : await inspectBackup(archive);
  console.log(JSON.stringify({ ok: true, mode: args.includes('--apply') ? 'apply' : 'dry-run', ...result }));
} finally { if (temp) await rm(temp, { recursive: true, force: true }); }
