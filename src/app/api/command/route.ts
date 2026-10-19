import { z } from 'zod';
import { command, getSnapshot } from '@/server/domain';
import { query } from '@/server/db';
import { requireOwner, assertOrigin, failure, readJson } from '@/server/http';
import { captureRuntimeControl } from '@/server/runtime';
import { drainRuntime } from '@/server/runtime-outbox';
import { publishRuntimeWake } from '@/server/runtime-queue';
import { checkModel } from '@/server/model-check';
import { after } from 'next/server';
import { consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';
export const runtime='nodejs';
const schema=z.object({type:z.string().min(1).max(80),payload:z.record(z.string(),z.unknown()).default({}),requestId:z.string().min(8).max(128)});
export async function POST(request:Request){
  try {
    assertOrigin(request);const{workspace,session}=await requireOwner(request);
    await consumeRateLimit('command-owner', session.user.id, 120, 60);
    const p=schema.parse(await readJson(request,80000));
    if(p.type==='settings.checkModel')return Response.json({result:await checkModel(workspace.id,p.payload,p.requestId)});
    const bindings:Record<string,any>={};
    const prior=(await query('SELECT request_id FROM command_requests WHERE workspace_id=$1 AND request_id=$2',[workspace.id,p.requestId])).rows[0];
    if(!prior&&(p.type==='approval.decide'||p.type==='task.resume')){
      const snapshot=await getSnapshot(workspace.id);
      const taskId=p.type==='approval.decide'?snapshot.approvals.find(a=>a.id===p.payload.id)?.taskId:p.payload.id;
      if(typeof taskId==='string')bindings[taskId]=await captureRuntimeControl(taskId,p.type==='approval.decide'?String(p.payload.decision):'resume',p.type==='approval.decide'?{approvalId:p.payload.id}:{text:p.payload.comment||''});
    }
    const result=await command(workspace.id,p.type,p.payload,p.requestId,bindings);
    if(process.env.VERCEL){
      // Publish before responding. The persisted outbox remains recoverable if
      // delivery fails; the command has already committed and must not repeat.
      try{await publishRuntimeWake(workspace.id);}catch{console.error('Runtime wake delivery failed; persisted outbox awaits reconciliation.');}
    }else after(()=>drainRuntime(workspace.id));
    return Response.json({result},{headers:{'Cache-Control':'no-store'}});
  }catch(error){return rateLimitFailure(error) ?? failure(error);}
}
