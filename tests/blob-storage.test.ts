import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobPreconditionFailedError } from '@vercel/blob';
import { blobPath, privateUploadPermission, readPrivateBlob, sealPrivateBlob } from '../src/server/blob-storage';

const id = '12345678-1234-1234-1234-123456789abc';
const path = blobPath('orvo-personal', id, 'notes.md', 'staging');

test('upload permission scopes private PUT to exact workspace/file, size, MIME and expiry', async () => {
  const calls: any[] = [];
  const fake = {
    issueSignedToken: async (options: any) => { calls.push(['issue', options]); return { delegationToken: 'delegation', clientSigningToken: 'signing', validUntil: options.validUntil }; },
    presignUrl: async (_token: any, options: any) => { calls.push(['presign', options]); return { presignedUrl: 'https://vercel.com/api/blob/?signed=short' }; },
  };
  const until = Date.now() + 60_000;
  const permission = await privateUploadPermission(path, 123, 'text/plain', until, fake as any);
  assert.deepEqual(calls[0][1], { pathname: path, operations: ['put'], validUntil: until, allowedContentTypes: ['text/plain'], maximumSizeInBytes: 123 });
  assert.deepEqual(calls[1][1], { pathname: path, operation: 'put', access: 'private', validUntil: until, allowedContentTypes: ['text/plain'], maximumSizeInBytes: 123, addRandomSuffix: false, allowOverwrite: false });
  assert.equal(permission.headers['Content-Type'], 'text/plain');
  assert.equal(permission.uploadUrl.includes('signing'), false);
  assert.equal(blobPath('orvo-personal', id, 'notes.md', 'sealed').includes('/sealed.md'), true);
  assert.throws(() => blobPath('../other', id, 'notes.md', 'staging'));
  assert.throws(() => blobPath('orvo-personal', '../other', 'notes.md', 'staging'));
});

test('invalid size, MIME and expiry issue no token', async () => {
  let calls = 0;
  const fake = { issueSignedToken: async () => { calls++; throw new Error('unreachable'); }, presignUrl: async () => { throw new Error('unreachable'); } };
  await assert.rejects(privateUploadPermission(path, 10 * 1024 * 1024 + 1, 'text/plain', Date.now() + 60_000, fake as any));
  await assert.rejects(privateUploadPermission(path, 10, 'text/html', Date.now() + 60_000, fake as any));
  await assert.rejects(privateUploadPermission(path, 10, 'text/plain', Date.now() - 1, fake as any));
  assert.equal(calls, 0);
});

test('private read is bounded even when response omits content length', async () => {
  const fake = { get: async () => ({ statusCode: 200, blob: { size: 0 }, stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } }) }) };
  await assert.rejects(readPrivateBlob(path, fake as any), (error: any) => error.code === 'FILE_TOO_LARGE');
});

test('sealed private object cannot be replaced by a replayed upload', async () => {
  const content = Buffer.from('accepted bytes');
  const stored = Buffer.from(content);
  let puts = 0;
  const fake = {
    put: async (_path: string, _bytes: Buffer, options: any) => { puts++; assert.equal(options.access, 'private'); assert.equal(options.allowOverwrite, false); assert.equal(options.addRandomSuffix, false); throw new BlobPreconditionFailedError(); },
    get: async (_path: string, options: any) => { assert.equal(options.access, 'private'); return { statusCode: 200, blob: { size: stored.length }, stream: new ReadableStream({ start(controller) { controller.enqueue(stored); controller.close(); } }) }; },
  };
  const sealed = blobPath('orvo-personal', id, 'notes.md', 'sealed');
  assert.equal(await sealPrivateBlob(sealed, content, 'text/plain', fake as any), sealed);
  await assert.rejects(sealPrivateBlob(sealed, Buffer.from('changed bytes'), 'text/plain', fake as any), (error: any) => error.code === 'FILE_CHANGED');
  assert.equal(puts, 2);
});
