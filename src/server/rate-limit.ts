import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { query } from './db';
import { DomainError } from '../shared/types';
import { readJson } from './http';

export class RateLimitError extends DomainError {
  constructor(public readonly retryAfter: number) {
    super('RATE_LIMITED', 'Слишком много запросов. Повторите позже.', 429);
  }
}

export function normalizeAuthRateResponse(response: Response): Response {
  if(response.status!==429||response.headers.has('Retry-After'))return response;
  const vendorRetry=Number(response.headers.get('X-Retry-After'));
  const headers=new Headers(response.headers);
  headers.set('Retry-After',String(Number.isFinite(vendorRetry)&&vendorRetry>0?Math.ceil(vendorRetry):60));
  headers.set('Cache-Control','no-store');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

function secret() {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value || value.length < 32) throw new DomainError('RATE_LIMIT_UNAVAILABLE', 'Защита запросов временно недоступна.', 503);
  return value;
}

export function clientAddress(request: Request) {
  if (process.env.VERCEL) {
    const first = request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ?? '';
    return isIP(first) ? first : 'unknown-vercel-client';
  }
  return 'local-client';
}

function bucketKey(scope: string, identity: string) {
  return createHmac('sha256', secret()).update(scope).update('\0').update(identity).digest('hex');
}

export async function rebuildBoundedAuthPost(request: Request) {
  const body = await readJson(request, 16 * 1024);
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  const forwarded = new Request(request.url, {
    method: 'POST', headers, body: JSON.stringify(body), signal: request.signal,
  });
  return { body, forwarded };
}

export async function pruneExpiredRateBuckets(limit = 50) {
  const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));
  const result = await query<{key:string}>(`
    DELETE FROM rate_buckets WHERE key IN (
      SELECT key FROM rate_buckets
      WHERE reset_at < now() - interval '1 day'
      ORDER BY reset_at LIMIT $1
    ) RETURNING key
  `, [bounded]);
  return result.rows.length;
}

export async function consumeRateLimit(scope: string, identity: string, maximum: number, windowSeconds: number) {
  if (!/^[a-z0-9.-]{1,80}$/.test(scope) || !identity || !Number.isInteger(maximum) || maximum < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new DomainError('RATE_LIMIT_UNAVAILABLE', 'Защита запросов временно недоступна.', 503);
  }
  try {
    const result = await query<{count: number; retry_after: number}>(`
      INSERT INTO rate_buckets(key,count,reset_at)
      VALUES($1,1,now() + $2::integer * interval '1 second')
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN rate_buckets.reset_at <= now() THEN 1 ELSE LEAST(rate_buckets.count + 1, $3::integer + 1) END,
        reset_at = CASE WHEN rate_buckets.reset_at <= now() THEN now() + $2::integer * interval '1 second' ELSE rate_buckets.reset_at END
      RETURNING count, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (reset_at - now())))::integer) AS retry_after
    `, [bucketKey(scope, identity), windowSeconds, maximum]);
    const row = result.rows[0];
    if (!row) throw new Error('Rate bucket was not returned.');
    // Opportunistic bounded cleanup keeps rotating addresses from growing the table forever.
    if (Math.random() < 0.01) await pruneExpiredRateBuckets();
    if (Number(row.count) > maximum) throw new RateLimitError(Number(row.retry_after));
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    throw new DomainError('RATE_LIMIT_UNAVAILABLE', 'Защита запросов временно недоступна.', 503);
  }
}

export function rateLimitFailure(error: unknown): Response | null {
  if (error instanceof RateLimitError) return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: 429, headers: { 'Retry-After': String(error.retryAfter), 'Cache-Control': 'no-store' } },
  );
  if (error instanceof DomainError && error.code === 'RATE_LIMIT_UNAVAILABLE') return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
  return null;
}
