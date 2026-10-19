// eve executes in a separate Nitro process. The Next process owns the domain DB
// connection (including the single-process PGlite test database).
type Domain = typeof import('../../src/server/domain');
type Action = 'prepareTask' | 'getTask' | 'claimTask' | 'releaseTask' | 'setTaskStatus' | 'recordTaskEvent' | 'reserveUsage' | 'settleUsage' | 'saveResult' | 'failTask' | 'createApproval';
export class DomainRpcError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'DomainRpcError'; }
}

async function call<K extends Action>(action: K, args: Parameters<Domain[K]>): Promise<Awaited<ReturnType<Domain[K]>>> {
  const secret = process.env.ORVO_RUNTIME_SECRET;
  if (!secret || secret.length < 32) throw new Error('Runtime authentication is not configured.');
  const origin = process.env.ORVO_RUNTIME_URL ?? 'http://127.0.0.1:3000';
  const response = await fetch(new URL('/api/runtime/domain', origin), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action, args }),
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.json() as { result?: unknown; error?: { code?: string; message?: string } };
  if (!response.ok || body.error) throw new DomainRpcError(body.error?.code ?? 'DOMAIN_RPC_FAILED', body.error?.message ?? 'Domain operation failed.');
  return body.result as Awaited<ReturnType<Domain[K]>>;
}

export const prepareTask = (...args: Parameters<Domain['prepareTask']>) => call('prepareTask', args);
export const getTask = (...args: Parameters<Domain['getTask']>) => call('getTask', args);
export const claimTask = (...args: Parameters<Domain['claimTask']>) => call('claimTask', args);
export const releaseTask = (...args: Parameters<Domain['releaseTask']>) => call('releaseTask', args);
export const setTaskStatus = (...args: Parameters<Domain['setTaskStatus']>) => call('setTaskStatus', args);
export const recordTaskEvent = (...args: Parameters<Domain['recordTaskEvent']>) => call('recordTaskEvent', args);
export const reserveUsage = (...args: Parameters<Domain['reserveUsage']>) => call('reserveUsage', args);
export const settleUsage = (...args: Parameters<Domain['settleUsage']>) => call('settleUsage', args);
export const saveResult = (...args: Parameters<Domain['saveResult']>) => call('saveResult', args);
export const failTask = (...args: Parameters<Domain['failTask']>) => call('failTask', args);
export const createApproval = (...args: Parameters<Domain['createApproval']>) => call('createApproval', args);
