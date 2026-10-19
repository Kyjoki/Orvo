import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appOrigin } from '../src/server/app-origin';
import { assertOrigin } from '../src/server/http';

test('Preview auth origin follows only its validated deployment URL', () => {
  const env = { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'orvo-preview-abc.vercel.app', BETTER_AUTH_URL: 'https://orvo.example.com' };
  assert.equal(appOrigin(env), 'https://orvo-preview-abc.vercel.app');
  assert.throws(() => appOrigin({ ...env, VERCEL_URL: 'orvo.vercel.app.attacker.test' }), /VERCEL_URL/);
  assert.throws(() => appOrigin({ ...env, VERCEL_URL: undefined }), /VERCEL_URL/);
});

test('Production respects a single explicit HTTPS auth origin', () => {
  const env = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_URL: 'orvo-prod-abc.vercel.app', BETTER_AUTH_URL: 'https://office.example.com' };
  assert.equal(appOrigin(env), 'https://office.example.com');
  assert.equal(appOrigin({ ...env, BETTER_AUTH_URL: undefined }), 'https://orvo-prod-abc.vercel.app');
  for (const url of ['http://office.example.com', 'https://*.example.com', 'https://office.example.com/path', 'https://user:pass@office.example.com']) {
    assert.throws(() => appOrigin({ ...env, BETTER_AUTH_URL: url }), /BETTER_AUTH_URL/);
  }
});

test('Local auth origin keeps explicit localhost configuration', () => {
  assert.equal(appOrigin({ BETTER_AUTH_URL: 'http://localhost:4789' }), 'http://localhost:4789');
  assert.equal(appOrigin({}), 'http://127.0.0.1:3000');
});

test('CSRF check accepts only the exact Preview origin', () => {
  const keys = ['VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'BETTER_AUTH_URL'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_URL = 'orvo-preview-abc.vercel.app';
    process.env.BETTER_AUTH_URL = 'https://office.example.com';
    assert.doesNotThrow(() => assertOrigin(new Request('https://orvo-preview-abc.vercel.app/api/command', { headers: { origin: 'https://orvo-preview-abc.vercel.app' } })));
    for (const origin of ['https://office.example.com', 'https://other.vercel.app', 'http://orvo-preview-abc.vercel.app']) {
      assert.throws(() => assertOrigin(new Request('https://orvo-preview-abc.vercel.app/api/command', { headers: { origin } })), { code: 'INVALID_ORIGIN' });
    }
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
