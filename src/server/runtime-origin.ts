type RuntimeEnvironment = Partial<Record<
  'VERCEL' | 'VERCEL_ENV' | 'VERCEL_URL' | 'ORVO_RUNTIME_URL' | 'VERCEL_AUTOMATION_BYPASS_SECRET' | 'VERCEL_OIDC_TOKEN', string>>;

function hostedOnVercel(env: RuntimeEnvironment): boolean {
  return Boolean(env.VERCEL) && env.VERCEL_ENV !== 'development';
}

export function deploymentOrigin(env: RuntimeEnvironment = process.env as RuntimeEnvironment): string {
  const hostname = env.VERCEL_URL;
  if (!hostname || !hostname.endsWith('.vercel.app') || !hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('A valid VERCEL_URL deployment hostname is required.');
  }
  return `https://${hostname}`;
}

// Resolve at request time: Preview and Production must each call their own deployment.
export function runtimeOrigin(env: RuntimeEnvironment = process.env as RuntimeEnvironment): string {
  if (hostedOnVercel(env)) return deploymentOrigin(env);
  const configured = env.ORVO_RUNTIME_URL ?? 'http://127.0.0.1:3000';
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ORVO_RUNTIME_URL must be an HTTP(S) origin.');
  }
  return url.origin;
}

// This header bypasses Vercel's front-door protection, never Orvo's own bearer auth.
// Attach it only to the current immutable deployment URL, not arbitrary fetch targets.
export function runtimeProtectionHeaders(target: URL, env: RuntimeEnvironment = process.env as RuntimeEnvironment): Record<string, string> {
  if (!hostedOnVercel(env) || target.origin !== deploymentOrigin(env)) return {};
  const oidcToken = env.VERCEL_OIDC_TOKEN;
  if (oidcToken) return { 'x-vercel-trusted-oidc-idp-token': oidcToken };
  const secret = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return secret ? { 'x-vercel-protection-bypass': secret } : {};
}
