import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { Kysely } from 'kysely';
import { authDialect } from './auth-database';
import { appOrigin } from './app-origin';
let instance: ReturnType<typeof createAuth> | undefined;
async function createAuth() {
  const origin = appOrigin();
  if(process.env.ORVO_TEST_MODE==='1' && (process.env.VERCEL || !['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname)))throw new Error('Тестовый режим разрешён только в изолированном localhost окружении.');
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be configured (32+ characters).');
  const dialect = await authDialect();
  return betterAuth({
    appName:'Orvo', secret,
    baseURL:origin,
    database:{db:new Kysely({dialect}), type:'postgres'},
    emailAndPassword:{enabled:true,disableSignUp:true,minPasswordLength:12},
    session:{expiresIn:60*60*24*7,updateAge:60*60*24},
    rateLimit:{enabled:true,window:60,max:30,storage:'database'},
    advanced:{useSecureCookies:new URL(origin).protocol==='https:' || process.env.NODE_ENV === 'production'},
    trustedOrigins:[origin],
    plugins:[nextCookies()]
  });
}
export function getAuth() { return instance ??= createAuth(); }
