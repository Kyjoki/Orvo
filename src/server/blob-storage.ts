import { createHash } from 'node:crypto';
import { issueSignedToken, presignUrl, get, put, del, BlobPreconditionFailedError } from '@vercel/blob';
import { DomainError } from '../shared/types';

const MAX_SIZE = 10 * 1024 * 1024;
const sdk = { issueSignedToken, presignUrl, get, put };
type BlobSdk = typeof sdk;

export function blobPath(workspaceId: string, id: string, name: string, kind: 'staging' | 'sealed') {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(workspaceId)) throw new DomainError('INVALID_FILE', 'Некорректное пространство.');
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new DomainError('INVALID_FILE', 'Некорректный файл.');
  const extension = /\.(txt|md|pdf)$/i.exec(name)?.[0]?.toLowerCase();
  if (!extension) throw new DomainError('INVALID_FILE', 'Недопустимый формат файла.');
  return `orvo/${encodeURIComponent(workspaceId)}/${id}/${kind}${extension}`;
}

export async function privateUploadPermission(pathname: string, size: number, mime: string, validUntil: number, client: Pick<BlobSdk, 'issueSignedToken' | 'presignUrl'> = sdk) {
  if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE || !['text/plain', 'application/pdf'].includes(mime) || validUntil <= Date.now() || validUntil > Date.now() + 15 * 60_000) {
    throw new DomainError('INVALID_FILE', 'Некорректное разрешение загрузки.');
  }
  const token = await client.issueSignedToken({ pathname, operations: ['put'], validUntil, allowedContentTypes: [mime], maximumSizeInBytes: size });
  const { presignedUrl } = await client.presignUrl(token, { pathname, operation: 'put', access: 'private', validUntil, allowedContentTypes: [mime], maximumSizeInBytes: size, addRandomSuffix: false, allowOverwrite: false });
  return { uploadUrl: presignedUrl, method: 'PUT' as const, headers: { 'Content-Type': mime } };
}

export async function privateBlobStream(pathname: string, client: Pick<BlobSdk, 'get'> = sdk): Promise<ReadableStream<Uint8Array>> {
  const response = await client.get(pathname, { access: 'private', useCache: false });
  if (!response || response.statusCode !== 200) throw new DomainError('FILE_NOT_FOUND', 'Загруженный файл не найден.', 404);
  if (response.blob.size > MAX_SIZE) { await response.stream.cancel(); throw new DomainError('FILE_TOO_LARGE', 'Файл превышает лимит.'); }
  let size = 0;
  return response.stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { size += chunk.byteLength; if (size > MAX_SIZE) throw new DomainError('FILE_TOO_LARGE', 'Файл превышает лимит.'); controller.enqueue(chunk); } }));
}

export async function readPrivateBlob(pathname: string, client: Pick<BlobSdk, 'get'> = sdk): Promise<Buffer> {
  const stream = await privateBlobStream(pathname, client);
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SIZE) throw new DomainError('FILE_TOO_LARGE', 'Файл превышает лимит.');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export async function sealPrivateBlob(pathname: string, content: Buffer, mime: string, client: Pick<BlobSdk, 'put' | 'get'> = sdk) {
  if (content.length < 1 || content.length > MAX_SIZE) throw new DomainError('INVALID_FILE_SIZE', 'Размер загруженного файла не совпадает.');
  try {
    await client.put(pathname, content, { access: 'private', contentType: mime, addRandomSuffix: false, allowOverwrite: false });
  } catch (error) {
    if (!(error instanceof BlobPreconditionFailedError)) throw error;
    // A previous completion can have sealed the same bytes before its DB update.
    const existing = await readPrivateBlob(pathname, client);
    const digest = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
    if (digest(existing) !== digest(content)) throw new DomainError('FILE_CHANGED', 'Содержимое файла изменилось после проверки.', 409);
  }
  return pathname;
}

export async function discardPrivateBlob(pathname: string) { await del(pathname); }
