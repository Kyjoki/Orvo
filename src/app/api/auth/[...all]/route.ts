import { getAuth } from '@/server/auth';
import { clientAddress, consumeRateLimit, rateLimitFailure, rebuildBoundedAuthPost, normalizeAuthRateResponse } from '@/server/rate-limit';
import { failure } from '@/server/http';
export const runtime = 'nodejs';
export async function GET(request:Request) { return (await getAuth()).handler(request); }
export async function POST(request:Request) {
  try {
    const address = clientAddress(request);
    await consumeRateLimit('auth-ip', address, 60, 60);
    const {body,forwarded}=await rebuildBoundedAuthPost(request);
    if (new URL(request.url).pathname.endsWith('/api/auth/sign-in/email')) {
      await consumeRateLimit('login-ip', address, 10, 15 * 60);
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase().slice(0, 320) : '';
      await consumeRateLimit('login-email', email || 'invalid-email', 12, 15 * 60);
    }
    return normalizeAuthRateResponse(await (await getAuth()).handler(forwarded));
  } catch (error) {
    return rateLimitFailure(error) ?? failure(error);
  }
}
