import { z } from 'zod';
import { getAuth } from '@/server/auth';
import { assertOrigin, requireOwner, readJson, failure } from '@/server/http';
import { consumeRateLimit, rateLimitFailure, normalizeAuthRateResponse } from '@/server/rate-limit';
import { consumeTotpOnce, revokeMfaGrants } from '@/server/mfa';
import { DomainError } from '@/shared/types';
export const runtime='nodejs';
const schema=z.object({action:z.literal('disable'),password:z.string().min(1).max(1024),code:z.string().regex(/^\d{6}$/)});
export async function POST(request:Request){
  try{
    assertOrigin(request);
    const {session}=await requireOwner(request);
    await consumeRateLimit('mfa-manage-owner',session.user.id,6,15*60);
    const input=schema.parse(await readJson(request,4096));
    const origin=new URL(request.url).origin;
    const auth=await getAuth();
    const verify=await auth.handler(new Request(`${origin}/api/auth/two-factor/verify-totp`,{
      method:'POST',headers:{cookie:request.headers.get('cookie')||'',origin,'content-type':'application/json'},body:JSON.stringify({code:input.code,trustDevice:false}),
    }));
    if(!verify.ok)throw new DomainError('MFA_CODE_INVALID','Текущий код аутентификатора не принят.',403);
    await consumeTotpOnce(session.user.id,input.code);
    const response=normalizeAuthRateResponse(await auth.handler(new Request(`${origin}/api/auth/two-factor/disable`,{
      method:'POST',headers:{cookie:request.headers.get('cookie')||'',origin,'content-type':'application/json'},body:JSON.stringify({password:input.password}),
    })));
    if(response.ok)await revokeMfaGrants(session.user.id);
    response.headers.set('Cache-Control','no-store');
    return response;
  }catch(error){return rateLimitFailure(error)??failure(error);}
}
