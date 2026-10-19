import { timingSafeEqual } from 'node:crypto';
import { eveChannel } from 'eve/channels/eve';
import type { AuthFn } from 'eve/channels/auth';

const internalBearer: AuthFn<Request> = (request) => {
  const secret = process.env.ORVO_RUNTIME_SECRET;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /i, '');
  if (!secret || secret.length < 32 || !supplied) return null;
  const a = Buffer.from(secret);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const taskId = request.headers.get('x-orvo-task-id') ?? '';
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) return null;
  return { authenticator: 'orvo-internal', principalId: 'orvo-api', principalType: 'service', attributes: { taskId } };
};

// No localDev/anonymous fallback: Next APIs authenticate the human owner first.
export default eveChannel({ auth: internalBearer });
