import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contentSecurityPolicy} from '../src/server/security-headers';
test('production CSP authorizes only nonce scripts and blocks embedding and plugins',()=>{
 const csp=contentSecurityPolicy('mDKYxjEebjV5zQ7Rfh9Pm7Ux');
 const script=csp.split('; ').find(v=>v.startsWith('script-src'))!;
 assert.ok(script.includes("'nonce-mDKYxjEebjV5zQ7Rfh9Pm7Ux'"));
 assert.ok(!script.includes('unsafe-inline'));assert.ok(!script.includes('unsafe-eval'));
 assert.ok(csp.includes("frame-ancestors 'none'"));assert.ok(csp.includes("object-src 'none'"));
 assert.ok(csp.includes('https://*.private.blob.vercel-storage.com'));
 assert.throws(()=>contentSecurityPolicy("bad'; script-src *"));
});
