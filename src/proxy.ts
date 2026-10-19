import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { contentSecurityPolicy } from './server/security-headers';

export function proxy(request: NextRequest) {
  const nonce=randomBytes(24).toString('base64');
  const policy=contentSecurityPolicy(nonce,process.env.NODE_ENV==='development');
  const headers=new Headers(request.headers);
  // Ignore client-supplied policy/nonce: Next applies this nonce to its scripts.
  headers.set('x-nonce',nonce);
  headers.set('Content-Security-Policy',policy);
  const response=NextResponse.next({request:{headers}});
  response.headers.set('Content-Security-Policy',policy);
  response.headers.set('Cache-Control','private, no-store');
  return response;
}

export const config={matcher:['/','/login','/office/:path*','/tasks/:path*','/agents/:path*','/history/:path*','/settings/:path*']};
