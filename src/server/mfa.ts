import { createHmac } from 'node:crypto';
import { query } from './db';
import { DomainError } from '../shared/types';

export function mfaRequired() {
  return process.env.ORVO_REQUIRE_MFA === '1' || (Boolean(process.env.VERCEL) && process.env.ORVO_REQUIRE_MFA !== '0');
}

export async function mfaStatus(session: { user: { id:string; twoFactorEnabled?:boolean|null }; session: { id:string } }) {
  const enabled = session.user.twoFactorEnabled === true;
  const required = mfaRequired();
  const grant = enabled ? (await query('SELECT 1 FROM mfa_session_grants WHERE session_id=$1 AND user_id=$2',[session.session.id,session.user.id])).rows[0] : null;
  return {required,enabled,verifiedSession:!!grant,setupRequired:required&&!enabled,stepUpRequired:enabled&&!grant};
}

export async function grantVerifiedSession(sessionId:string,userId:string, code:string) {
  if (!sessionId || !userId) throw new DomainError('MFA_VERIFICATION_FAILED','Не удалось подтвердить второй фактор.',403);
  const found=(await query<{id:string;userId:string;twoFactorEnabled:boolean}>(
    'SELECT s.id,s."userId",u."twoFactorEnabled" FROM "session" s JOIN "user" u ON u.id=s."userId" WHERE s.id=$1 AND s."userId"=$2 AND s."expiresAt">now()', [sessionId,userId]
  )).rows[0];
  if(!found?.twoFactorEnabled)throw new DomainError('MFA_VERIFICATION_FAILED','Не удалось подтвердить второй фактор.',403);
  if(!/^[0-9]{6}$/.test(code))throw new DomainError('MFA_VERIFICATION_FAILED','Некорректный код подтверждения.',403);
  await consumeTotpOnce(found.userId,code);
  await query('INSERT INTO mfa_session_grants(session_id,user_id) VALUES($1,$2) ON CONFLICT(session_id) DO NOTHING',[found.id,found.userId]);
  return found;
}

export async function consumeTotpOnce(userId:string,code:string){
  const secret=process.env.BETTER_AUTH_SECRET;
  if(!secret||secret.length<32)throw new DomainError('MFA_UNAVAILABLE','Защита входа временно недоступна.',503);
  const key=createHmac('sha256',secret).update(userId).update('\0').update(code).digest('hex');
  const rows=(await query<{key:string}>(`
    INSERT INTO mfa_totp_replay(key,expires_at) VALUES($1,now()+interval '90 seconds')
    ON CONFLICT(key) DO UPDATE SET expires_at=EXCLUDED.expires_at
    WHERE mfa_totp_replay.expires_at<=now() RETURNING key
  `,[key])).rows;
  if(!rows.length)throw new DomainError('MFA_CODE_REUSED','Этот код уже использован. Дождитесь следующего кода.',409);
}

export async function revokeMfaGrants(userId:string){await query('DELETE FROM mfa_session_grants WHERE user_id=$1',[userId]);}
