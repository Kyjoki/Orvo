import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeOrigin, runtimeProtectionHeaders } from '../src/server/runtime-origin';

const preview = {
  VERCEL: '1',
  VERCEL_ENV: 'preview',
  VERCEL_URL: 'orvo-preview-abc.vercel.app',
  ORVO_RUNTIME_URL: 'http://127.0.0.1:3000',
  VERCEL_AUTOMATION_BYPASS_SECRET: 'fixture-secret-do-not-log',
};

test('hosted runtime always uses the current HTTPS deployment origin', () => {
  assert.equal(runtimeOrigin(preview), 'https://orvo-preview-abc.vercel.app');
  assert.equal(runtimeOrigin({ ...preview, VERCEL_ENV: 'production' }), 'https://orvo-preview-abc.vercel.app');
  assert.throws(() => runtimeOrigin({ ...preview, VERCEL_URL: undefined }), /VERCEL_URL/);
  for (const hostname of ['evil.example.com', 'orvo.vercel.app.evil.com', 'orvo..vercel.app', 'orvo.vercel.app:443', 'https://orvo.vercel.app']) {
    assert.throws(() => runtimeOrigin({ ...preview, VERCEL_URL: hostname }), /VERCEL_URL/);
  }
});

test('local runtime respects explicit HTTP origin, including vercel dev', () => {
  assert.equal(runtimeOrigin({ ORVO_RUNTIME_URL: 'http://localhost:4789' }), 'http://localhost:4789');
  assert.equal(runtimeOrigin({ ...preview, VERCEL_ENV: 'development' }), 'http://127.0.0.1:3000');
  assert.throws(() => runtimeOrigin({ ORVO_RUNTIME_URL: 'https://example.com/path' }), /origin/);
});

test('protection bypass header is confined to this deployment origin', () => {
  const own = new URL('https://orvo-preview-abc.vercel.app/eve/v1/sessions');
  assert.deepEqual(runtimeProtectionHeaders(own, preview), { 'x-vercel-protection-bypass': preview.VERCEL_AUTOMATION_BYPASS_SECRET });
  for (const url of ['https://orvo-preview-abc.vercel.app.evil.com/eve/v1', 'https://other.vercel.app/eve/v1', 'http://orvo-preview-abc.vercel.app/eve/v1']) {
    assert.deepEqual(runtimeProtectionHeaders(new URL(url), preview), {});
  }
  assert.deepEqual(runtimeProtectionHeaders(own, { ...preview, VERCEL_AUTOMATION_BYPASS_SECRET: undefined }), {});
  assert.deepEqual(runtimeProtectionHeaders(own, { ...preview, VERCEL_ENV: 'development' }), {});
});

test('trusted-source OIDC is preferred and isolated to this deployment', () => {
  const env = { ...preview, VERCEL_OIDC_TOKEN: 'fixture-oidc-token' };
  const own = new URL('https://orvo-preview-abc.vercel.app/api/runtime/domain');
  assert.deepEqual(runtimeProtectionHeaders(own, env), { 'x-vercel-trusted-oidc-idp-token': env.VERCEL_OIDC_TOKEN });
  assert.deepEqual(runtimeProtectionHeaders(new URL('https://other.vercel.app/api/runtime/domain'), env), {});
});
