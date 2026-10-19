import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { contentSecurityPolicy } from './server/security-headers';
import { appOrigin } from './server/app-origin';

export function proxy(request: NextRequest) {
  if(process.env.VERCEL && process.env.VERCEL_ENV==='preview' && process.env.ORVO_PREVIEW_ORIGIN){
    const canonical=appOrigin();
    if(request.nextUrl.origin!==canonical){
      const destination=new URL(canonical);
      destination.pathname=request.nextUrl.pathname;
      destination.search=request.nextUrl.search;
      const response=NextResponse.redirect(destination,307);
      response.headers.set('Cache-Control','private, no-store');
      return response;
    }
  }
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

export const config={matcher:['/','/login','/security/:path*','/office/:path*','/tasks/:path*','/agents/:path*','/history/:path*','/settings/:path*']};
