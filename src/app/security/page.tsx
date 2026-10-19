import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import SecuritySettings from '@/components/SecuritySettings';
import { appOrigin } from '@/server/app-origin';
import { requireOwnerSession } from '@/server/http';
export const dynamic='force-dynamic';
export default async function SecurityPage(){
  const requestHeaders=await headers();
  if(process.env.ORVO_TEST_MODE==='1'&&!process.env.DATABASE_URL){
    const response=await fetch(new URL('/api/session',appOrigin()),{headers:{cookie:requestHeaders.get('cookie')||''},cache:'no-store'});
    if(!response.ok)redirect('/login');
  }else{
    await requireOwnerSession(new Request(appOrigin(),{headers:requestHeaders})).catch(()=>redirect('/login'));
  }
  return <SecuritySettings/>;
}
