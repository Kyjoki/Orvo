import { headers } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import OrvoApp from '@/components/OrvoApp';
import { getAuth } from '@/server/auth';
export const dynamic = 'force-dynamic';
export default async function WorkspacePage({params}:{params:Promise<{path:string[]}>}) {
  const {path} = await params;
  if (!['office','tasks','agents','history','settings'].includes(path[0])) notFound();
  const requestHeaders=await headers();
  if(process.env.ORVO_TEST_MODE==='1'&&!process.env.DATABASE_URL){
    // Keep the embedded WASM database inside the Route Handler runtime; RSC
    // executes in a separate React realm. This endpoint validates the session.
    const result=await fetch(new URL('/api/session',process.env.BETTER_AUTH_URL||'http://127.0.0.1:3000'),{headers:{cookie:requestHeaders.get('cookie')||''},cache:'no-store'});
    if(!result.ok)redirect('/login');
  }else{
    const session=await (await getAuth()).api.getSession({headers:requestHeaders});
    if(!session)redirect('/login');
  }
  return <OrvoApp path={path}/>;
}
