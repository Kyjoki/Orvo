import { deploymentOrigin } from './runtime-origin';

type AppEnvironment = Partial<Record<'VERCEL' | 'VERCEL_ENV' | 'VERCEL_URL' | 'BETTER_AUTH_URL' | 'ORVO_PREVIEW_ORIGIN', string>>;

function configuredOrigin(value: string, requireHttps: boolean, name = 'BETTER_AUTH_URL'): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${name} must be a valid HTTP(S) origin.`); }
  if (!['http:', 'https:'].includes(url.protocol) || (requireHttps && url.protocol !== 'https:') ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) {
    throw new Error(`${name} must be a valid HTTP(S) origin.`);
  }
  return url.origin;
}

// A Preview alias is explicit server configuration; never infer trusted origins
// from Host/forwarded headers or a production BETTER_AUTH_URL.
export function appOrigin(env: AppEnvironment = process.env as AppEnvironment): string {
  if (env.VERCEL && env.VERCEL_ENV === 'preview') {
    if (env.ORVO_PREVIEW_ORIGIN) return configuredOrigin(env.ORVO_PREVIEW_ORIGIN, true, 'ORVO_PREVIEW_ORIGIN');
    return deploymentOrigin(env);
  }
  if (env.BETTER_AUTH_URL) return configuredOrigin(env.BETTER_AUTH_URL, Boolean(env.VERCEL) && env.VERCEL_ENV !== 'development');
  if (env.VERCEL && env.VERCEL_ENV !== 'development') return deploymentOrigin(env);
  return 'http://127.0.0.1:3000';
}
