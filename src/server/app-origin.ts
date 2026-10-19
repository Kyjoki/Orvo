import { deploymentOrigin } from './runtime-origin';

type AppEnvironment = Partial<Record<'VERCEL' | 'VERCEL_ENV' | 'VERCEL_URL' | 'BETTER_AUTH_URL', string>>;

function configuredOrigin(value: string, requireHttps: boolean): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('BETTER_AUTH_URL must be a valid HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || (requireHttps && url.protocol !== 'https:') ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) {
    throw new Error('BETTER_AUTH_URL must be a valid HTTP(S) origin.');
  }
  return url.origin;
}

// Preview uses its immutable deployment host even when a production URL is set.
export function appOrigin(env: AppEnvironment = process.env as AppEnvironment): string {
  if (env.VERCEL && env.VERCEL_ENV === 'preview') return deploymentOrigin(env);
  if (env.BETTER_AUTH_URL) return configuredOrigin(env.BETTER_AUTH_URL, Boolean(env.VERCEL) && env.VERCEL_ENV !== 'development');
  if (env.VERCEL && env.VERCEL_ENV !== 'development') return deploymentOrigin(env);
  return 'http://127.0.0.1:3000';
}
