import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAuthRateResponse} from '../src/server/rate-limit';
import { createHmac, randomUUID } from 'node:crypto';

process.env.ORVO_TEST_MODE = '1';
delete process.env.DATABASE_URL;
delete process.env.ORVO_TEST_DB_DIR;
process.env.ORVO_TEST_DB_NAME = `rate-${process.pid}-${randomUUID().slice(0, 8)}`;
process.env.BETTER_AUTH_SECRET = 'test-only-rate-limit-secret-000000000000000000';

const { consumeRateLimit, clientAddress, rateLimitFailure, RateLimitError, rebuildBoundedAuthPost, pruneExpiredRateBuckets } = await import('../src/server/rate-limit');
const { query, getDatabase } = await import('../src/server/db');
after(async () => {
  const database = await getDatabase();
  if (database.kind === 'pglite') await database.db.close();
});

test('concurrent requests are counted atomically and return a bounded Retry-After', async () => {
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => consumeRateLimit('test-concurrent', 'owner-1', 5, 60)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 5);
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(rejected.length, 15);
  for (const result of rejected) {
    if (result.status !== 'rejected') continue;
    assert.ok(result.reason instanceof RateLimitError);
    const response = rateLimitFailure(result.reason)!;
    assert.equal(response.status, 429);
    const retry = Number(response.headers.get('Retry-After'));
    assert.ok(retry >= 1 && retry <= 60);
  }
  const rows = (await query<{key:string;count:number}>('SELECT key,count FROM rate_buckets')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 6);
  assert.ok(!rows[0].key.includes('owner-1'));
});

test('identities are separate and expiry permits a new window', async () => {
  await consumeRateLimit('test-expiry', 'alice@example.com', 1, 60);
  await consumeRateLimit('test-expiry', 'bob@example.com', 1, 60);
  await assert.rejects(consumeRateLimit('test-expiry', 'alice@example.com', 1, 60), (error: unknown) => error instanceof RateLimitError);
  await query("UPDATE rate_buckets SET reset_at=now()-interval '1 second' WHERE count=2");
  await consumeRateLimit('test-expiry', 'alice@example.com', 1, 60);
  const rows = (await query<{key:string}>('SELECT key FROM rate_buckets')).rows;
  assert.ok(rows.every((row) => !row.key.includes('@')));
});

test('untrusted forwarding headers cannot split local buckets', () => {
  const old = process.env.VERCEL;
  try {
    delete process.env.VERCEL;
    assert.equal(clientAddress(new Request('http://localhost', { headers: { 'x-vercel-forwarded-for': '1.2.3.4' } })), 'local-client');
    process.env.VERCEL = '1';
    assert.equal(clientAddress(new Request('https://example.com', { headers: { 'x-vercel-forwarded-for': '1.2.3.4, 10.0.0.1' } })), '1.2.3.4');
    assert.equal(clientAddress(new Request('https://example.com', { headers: { 'x-vercel-forwarded-for': 'attacker-value' } })), 'unknown-vercel-client');
  } finally {
    if (old === undefined) delete process.env.VERCEL; else process.env.VERCEL = old;
  }
});

test('missing HMAC secret fails closed with a safe 503', async () => {
  const old = process.env.BETTER_AUTH_SECRET;
  try {
    delete process.env.BETTER_AUTH_SECRET;
    await assert.rejects(consumeRateLimit('test-secret', 'owner', 1, 60), (error: any) => {
      const response = rateLimitFailure(error);
      return response?.status === 503 && error.code === 'RATE_LIMIT_UNAVAILABLE' && !error.message.includes('SQL');
    });
  } finally {
    process.env.BETTER_AUTH_SECRET = old;
  }
});

test('bounded auth inspection forwards small JSON and required headers for all POST routes', async () => {
  for (const path of ['sign-in/email', 'sign-up/email', 'sign-out']) {
    const body = JSON.stringify({ email: ' OWNER@EXAMPLE.COM ', password: 'fixture-only-password' });
    const request = new Request(`http://127.0.0.1:3000/api/auth/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000', cookie: 'session=fixture', 'content-length': String(body.length) }, body,
    });
    const forwarded = await rebuildBoundedAuthPost(request);
    assert.equal(forwarded.body.email.trim().toLowerCase(), 'owner@example.com');
    assert.deepEqual(await forwarded.forwarded.json(), JSON.parse(body));
    assert.equal(forwarded.forwarded.headers.get('origin'), 'http://127.0.0.1:3000');
    assert.equal(forwarded.forwarded.headers.get('cookie'), 'session=fixture');
    assert.equal(forwarded.forwarded.headers.get('content-type'), 'application/json');
    assert.equal(forwarded.forwarded.headers.get('content-length'), null);
  }
});

test('oversized streaming auth body rejects promptly without a tee branch', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(2048)); },
    cancel() { cancelled = true; },
  });
  const request = new Request('http://127.0.0.1:3000/api/auth/sign-in/email', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  const timeout = Symbol('timeout');
  const outcome = await Promise.race([
    rebuildBoundedAuthPost(request).then(() => 'accepted', (error: any) => error.code),
    new Promise<symbol>((resolve) => setTimeout(() => resolve(timeout), 1000)),
  ]);
  assert.equal(outcome, 'BODY_TOO_LARGE');
  assert.equal(cancelled, true);
});

test('Better Auth throttling exposes a standard Retry-After without changing other responses',async()=>{
 const response=normalizeAuthRateResponse(new Response('{"message":"Too many requests"}',{status:429,headers:{'X-Retry-After':'9','Content-Type':'application/json'}}));
 assert.equal(response.headers.get('Retry-After'),'9');
 assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.equal(await response.text(),'{"message":"Too many requests"}');
 const ok=new Response('ok');assert.equal(normalizeAuthRateResponse(ok),ok);
});

test('bounded cleanup removes old buckets and keeps active windows', async () => {
  await consumeRateLimit('test-cleanup', 'stale-address', 2, 60);
  await consumeRateLimit('test-cleanup', 'active-address', 2, 60);
  const key = (identity:string) => createHmac('sha256', process.env.BETTER_AUTH_SECRET!).update('test-cleanup').update('\0').update(identity).digest('hex');
  const stale = key('stale-address');
  const active = key('active-address');
  await query("UPDATE rate_buckets SET reset_at=now()-interval '2 days' WHERE key=$1", [stale]);
  assert.equal(await pruneExpiredRateBuckets(50), 1);
  const afterRows = (await query<{key:string}>('SELECT key FROM rate_buckets')).rows;
  assert.ok(!afterRows.some((row) => row.key === stale));
  assert.ok(afterRows.some((row) => row.key === active));
});
