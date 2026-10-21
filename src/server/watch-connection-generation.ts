import { createHash } from 'node:crypto';
import { query } from './db';

/** An opaque revision for one extension credential, never the credential verifier itself. */
export function watchConnectionGeneration(tokenHash: string) {
  return createHash('sha256').update(`orvo-watch-connection-v1\0${tokenHash}`).digest('hex');
}

export async function currentWatchConnectionGeneration(workspaceId: string): Promise<string | null> {
  const row = (await query<{ token_hash: string }>(
    'SELECT token_hash FROM watch_connections WHERE workspace_id=$1', [workspaceId],
  )).rows[0];
  return row ? watchConnectionGeneration(row.token_hash) : null;
}

export async function watchConnectionGenerationIsCurrent(workspaceId: string, generation: string) {
  if (!/^[a-f0-9]{64}$/.test(generation)) return false;
  return (await currentWatchConnectionGeneration(workspaceId)) === generation;
}
