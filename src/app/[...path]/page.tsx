import { headers } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import OrvoApp from '@/components/OrvoApp';
import { appOrigin } from '@/server/app-origin';
import { requireOwnerSession } from '@/server/http';
import { mfaStatus } from '@/server/mfa';
export const dynamic = 'force-dynamic';
export default async function WorkspacePage({params}:{params:Promise<{path:string[]}>}) {
  const {path} = await params;
  if (!['office','tasks','agents','history','settings'].includes(path[0])) notFound();
  const requestHeaders=await headers();
  if(process.env.ORVO_TEST_MODE==='1'&&!process.env.DATABASE_URL){
    // Keep the embedded WASM database inside the Route Handler runtime; RSC
    // executes in a separate React realm. This endpoint validates the session.
    const result=await fetch(new URL('/api/session',appOrigin()),{headers:{cookie:requestHeaders.get('cookie')||''},cache:'no-store'});
    if(!result.ok)redirect('/login');
    const state=await result.json();
    if(state.mfa?.setupRequired||state.mfa?.stepUpRequired)redirect('/security');
  }else{
    const request=new Request(appOrigin(),{headers:requestHeaders});
    const {session}=await requireOwnerSession(request).catch(()=>redirect('/login'));
    const mfa=await mfaStatus(session);
    if(mfa.setupRequired||mfa.stepUpRequired)redirect('/security');
  }
  return <OrvoApp path={path}/>;
}
