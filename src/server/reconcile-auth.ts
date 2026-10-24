import { createHash, timingSafeEqual } from 'node:crypto';

export function validReconcileRequest(request:Request,secret=process.env.ORVO_RECONCILE_SECRET){
  if(!secret || secret.length<32)return false;
  const provided=request.headers.get('x-orvo-reconcile-secret')||'';
  const expectedHash=createHash('sha256').update(secret).digest();
  const providedHash=createHash('sha256').update(provided).digest();
  return timingSafeEqual(expectedHash,providedHash);
}
