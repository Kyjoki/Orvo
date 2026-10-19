// Intentionally grants only outbox reconciliation, never general runtime RPC.
const origin = new URL(process.env.ORVO_DEPLOYMENT_URL || '');
if (origin.protocol !== 'https:' || !/^[a-z0-9-]+\.vercel\.app$/.test(origin.hostname) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('Expected exact HTTPS Vercel deployment origin.');
if (!process.env.ORVO_RECONCILE_SECRET || process.env.ORVO_RECONCILE_SECRET.length < 32) throw new Error('Missing reconciliation credential.');
const headers = {'x-orvo-reconcile-secret':process.env.ORVO_RECONCILE_SECRET};
if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const response = await fetch(new URL('/ops/reconcile', origin), {method:'POST', headers, redirect:'error', signal:AbortSignal.timeout(65000)});
if (!response.ok) throw new Error(`Reconciliation failed with HTTP ${response.status}.`);
const result = await response.json();
if (result.ok !== true || !Number.isInteger(result.workspaces)) throw new Error('Unexpected reconciliation response.');
console.log(JSON.stringify({ok:true,workspaces:result.workspaces}));
