import { handleCallback } from '@vercel/queue';
import { drainRuntime } from '@/server/runtime-outbox';
import { validWorkspaceId } from '@/server/runtime-queue';

export const runtime='nodejs';
export const maxDuration=300;

const callback=handleCallback<{workspaceId:unknown}>(async message=>{
  if(!message || !validWorkspaceId(message.workspaceId))throw new Error('Invalid runtime queue payload.');
  await drainRuntime(message.workspaceId);
},{retry:()=>({afterSeconds:30})});

export async function POST(request:Request){
  if(!process.env.VERCEL)return Response.json({error:{code:'FORBIDDEN'}},{status:403});
  return callback(request);
}
