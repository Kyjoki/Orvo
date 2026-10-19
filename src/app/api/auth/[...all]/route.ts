import { getAuth } from '@/server/auth';
import { clientAddress, consumeRateLimit, rateLimitFailure, rebuildBoundedAuthPost, normalizeAuthRateResponse } from '@/server/rate-limit';
import { failure, requireOwnerSession } from '@/server/http';
import { grantVerifiedSession } from '@/server/mfa';
import { query } from '@/server/db';
import { DomainError } from '@/shared/types';
export const runtime = 'nodejs';
export async function GET(request:Request) {
  const endpoint=new URL(request.url).pathname.split('/api/auth/')[1]||'';
  if(endpoint!=='get-session')return failure(new DomainError('AUTH_ENDPOINT_DISABLED','Этот метод авторизации недоступен.',403));
  return (await getAuth()).handler(request);
}
export async function POST(request:Request) {
  try {
    const address = clientAddress(request);
    await consumeRateLimit('auth-ip', address, 60, 60);
    const {body}=await rebuildBoundedAuthPost(request);
    if(!body||typeof body!=='object'||Array.isArray(body))throw new DomainError('INVALID_JSON','Ожидается объект JSON.',400);
    const endpoint=new URL(request.url).pathname.split('/api/auth/')[1]||'';
    if(!new Set(['sign-in/email','two-factor/enable','two-factor/verify-totp','two-factor/verify-backup-code','sign-out']).has(endpoint))
      throw new DomainError('AUTH_ENDPOINT_DISABLED','Этот метод авторизации недоступен.',403);
    if(endpoint==='two-factor/enable'){
      const {session}=await requireOwnerSession(request);
      if(session.user.twoFactorEnabled)throw new DomainError('MFA_ALREADY_ENABLED','Двухфакторная защита уже включена.',409);
      if(body?.method!=='totp')throw new DomainError('MFA_TOTP_ONLY','Поддерживается только приложение аутентификации.',400);
    }
    if (endpoint==='sign-in/email') {
      await consumeRateLimit('login-ip', address, 10, 15 * 60);
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase().slice(0, 320) : '';
      await consumeRateLimit('login-email', email || 'invalid-email', 12, 15 * 60);
    }
    if(endpoint==='two-factor/verify-totp'||endpoint==='two-factor/verify-backup-code'){
      // A password-only session predating MFA remains active while it waits for step-up.
      // Better Auth's sign-in lockout does not cover that authenticated branch.
      const existing=await (await getAuth()).api.getSession({headers:request.headers});
      if(existing)await consumeRateLimit('mfa-user',existing.user.id,6,15*60);
      body.trustDevice=false;
      if(endpoint==='two-factor/verify-backup-code')body.disableSession=false;
    }
    const headers=new Headers(request.headers);headers.delete('content-length');
    const forwarded=new Request(request.url,{method:'POST',headers,body:JSON.stringify(body),signal:request.signal});
    const response=normalizeAuthRateResponse(await (await getAuth()).handler(forwarded));
    if(response.ok&&(endpoint==='two-factor/verify-totp'||endpoint==='two-factor/verify-backup-code')){
      const cookies=new Map<string,string>();
      for(const part of (request.headers.get('cookie')||'').split(';')){const index=part.indexOf('=');if(index>0)cookies.set(part.slice(0,index).trim(),part.slice(index+1).trim());}
      for(const header of response.headers.getSetCookie()){
        const pair=header.split(';')[0];const index=pair.indexOf('=');if(index<1)continue;
        const name=pair.slice(0,index),value=pair.slice(index+1);
        if(/max-age=0/i.test(header)||!value)cookies.delete(name);else cookies.set(name,value);
      }
      const session=await (await getAuth()).api.getSession({headers:new Headers({cookie:[...cookies].map(([key,value])=>`${key}=${value}`).join('; ')})});
      if(!session)throw new DomainError('MFA_VERIFICATION_FAILED','Не удалось подтвердить второй фактор.',403);
      try{await grantVerifiedSession(session.session.id,session.user.id,endpoint==='two-factor/verify-totp'?'totp':'backup',body.code);}
      catch(error){await query('DELETE FROM "session" WHERE id=$1',[session.session.id]).catch(()=>{});throw error;}
    }
    return response;
  } catch (error) {
    return rateLimitFailure(error) ?? failure(error);
  }
}
