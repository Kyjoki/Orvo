import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOTP } from '@better-auth/utils/otp';
import { base32 } from '@better-auth/utils/base32';

process.env.ORVO_TEST_MODE='1';
process.env.ORVO_REQUIRE_MFA='1';
process.env.BETTER_AUTH_URL='http://127.0.0.1:3000';
process.env.BETTER_AUTH_SECRET='isolated-mfa-test-secret-000000000000000000';
process.env.ORVO_TEST_DB_NAME=`mfa-${process.pid}-${randomUUID().slice(0,8)}`;
process.env.ORVO_WORKSPACE_ID=`mfa-${process.pid}-${randomUUID().slice(0,8)}`;
delete process.env.DATABASE_URL;
delete process.env.ORVO_TEST_DB_DIR;
delete process.env.VERCEL;

const { migrate, getDatabase }=await import('../src/server/db');
const { getAuth }=await import('../src/server/auth');
const { getMigrations }=await import('better-auth/db/migration');
const { createOwner }=await import('../src/server/owner');
const { requireOwner }=await import('../src/server/http');
const { POST:authPost }=await import('../src/app/api/auth/[...all]/route');
const { POST:managePost }=await import('../src/app/api/security/manage/route');
const { GET:statusGet }=await import('../src/app/api/security/status/route');
const fixtureEmail='mfa-fixture@example.test';
const fixturePassword='fixture-password-never-real';

type Jar=Map<string,string>;
function updateJar(jar:Jar,response:Response){
  for(const header of response.headers.getSetCookie()){
    const pair=header.split(';')[0];const equal=pair.indexOf('=');if(equal<1)continue;
    const name=pair.slice(0,equal),value=pair.slice(equal+1);
    if(/max-age=0/i.test(header)||!value)jar.delete(name);else jar.set(name,value);
  }
}
function cookie(jar:Jar){return [...jar].map(([name,value])=>`${name}=${value}`).join('; ');}
async function post(jar:Jar,path:string,body:Record<string,unknown>,address?:string){
  const headers:Record<string,string>={origin:'http://127.0.0.1:3000','content-type':'application/json',cookie:cookie(jar)};
  if(address)headers['x-vercel-forwarded-for']=address;
  const request=new Request(`http://127.0.0.1:3000/api/auth/${path}`,{method:'POST',headers,body:JSON.stringify(body)});
  const response=await authPost(request);updateJar(jar,response);return response;
}
function ownerRequest(jar:Jar){return new Request('http://127.0.0.1:3000/api/state',{headers:{cookie:cookie(jar)}});}
async function manage(jar:Jar,body:Record<string,unknown>){return managePost(new Request('http://127.0.0.1:3000/api/security/manage',{method:'POST',headers:{origin:'http://127.0.0.1:3000','content-type':'application/json',cookie:cookie(jar)},body:JSON.stringify(body)}));}
after(async()=>{const database=await getDatabase();if(database.kind==='pglite')await database.db.close();else await database.pool.end();});

test('unconfirmed enrollment stays gated; verified session works; stale session and TOTP replay fail',async()=>{
  await migrate();const auth=await getAuth();await (await getMigrations(auth.options)).runMigrations();
  await createOwner(fixtureEmail,fixturePassword,'Fixture Owner');
  const jar:Jar=new Map();
  const login=await post(jar,'sign-in/email',{email:fixtureEmail,password:fixturePassword});
  assert.equal(login.status,200);
  const oldJar:Jar=new Map();
  assert.equal((await post(oldJar,'sign-in/email',{email:fixtureEmail,password:fixturePassword})).status,200);
  const statusBefore=await statusGet(ownerRequest(jar));
  assert.equal((await statusBefore.json()).setupRequired,true);
  await assert.rejects(requireOwner(ownerRequest(jar)),(error:any)=>error.code==='MFA_REQUIRED');
  assert.equal((await post(jar,'sign-up/email',{email:'unexpected@example.test',password:fixturePassword,name:'Unexpected'})).status,403);
  assert.equal((await post(jar,'change-password',{currentPassword:fixturePassword,newPassword:'different-password'})).status,403);
  const enrollment=await post(jar,'two-factor/enable',{password:fixturePassword,method:'totp'});
  assert.equal(enrollment.status,200);
  const enrollmentData=await enrollment.json();
  assert.equal(typeof enrollmentData.totpURI,'string');
  assert.ok(Array.isArray(enrollmentData.backupCodes));
  const backupCode=enrollmentData.backupCodes[0] as string;
  const secret=new URL(enrollmentData.totpURI).searchParams.get('secret')!;
  assert.equal((await (await statusGet(ownerRequest(jar))).json()).enabled,false);
  await assert.rejects(requireOwner(ownerRequest(jar)),(error:any)=>error.code==='MFA_REQUIRED');
  const currentCode=await createOTP(new TextDecoder().decode(base32.decode(secret))).totp();
  const verified=await post(jar,'two-factor/verify-totp',{code:currentCode,trustDevice:true});
  assert.equal(verified.status,200,JSON.stringify(await verified.clone().json()));
  const statusAfter=await(await statusGet(ownerRequest(jar))).json();
  assert.equal(statusAfter.enabled,true);assert.equal(statusAfter.verifiedSession,true);
  assert.ok((await requireOwner(ownerRequest(jar))).session.user.id);
  await assert.rejects(requireOwner(ownerRequest(oldJar)),(error:any)=>error.code==='MFA_REQUIRED');
  const secondJar:Jar=new Map();
  const secondLogin=await post(secondJar,'sign-in/email',{email:fixtureEmail,password:fixturePassword});
  assert.equal((await secondLogin.json()).twoFactorRedirect,true);
  const replay=await post(secondJar,'two-factor/verify-totp',{code:currentCode});
  assert.equal(replay.status,409);
  await assert.rejects(requireOwner(ownerRequest(secondJar)),(error:any)=>error.code==='UNAUTHENTICATED');
  // Better Auth also enforces a three-sign-ins-per-ten-seconds rule.
  await new Promise(resolve=>setTimeout(resolve,11000));
  const thirdJar:Jar=new Map();
  const thirdLogin=await post(thirdJar,'sign-in/email',{email:fixtureEmail,password:fixturePassword});
  assert.equal((await thirdLogin.json()).twoFactorRedirect,true);
  const recovered=await post(thirdJar,'two-factor/verify-backup-code',{code:backupCode,trustDevice:true});
  assert.equal(recovered.status,200);
  assert.equal((await(await statusGet(ownerRequest(thirdJar))).json()).verifiedSession,true);
  const fourthJar:Jar=new Map();
  const fourthLogin=await post(fourthJar,'sign-in/email',{email:fixtureEmail,password:fixturePassword});
  assert.equal((await fourthLogin.json()).twoFactorRedirect,true);
  const reusedBackup=await post(fourthJar,'two-factor/verify-backup-code',{code:backupCode});
  assert.equal(reusedBackup.ok,false);
  assert.equal((await post(thirdJar,'two-factor/disable',{password:fixturePassword})).status,403);
  const currentTime=Date.now;
  try{
    Date.now=()=>currentTime()+90_000;
    const freshCode=await createOTP(new TextDecoder().decode(base32.decode(secret))).totp();
    const regenerated=await manage(thirdJar,{action:'regenerate',password:fixturePassword,code:freshCode});
    assert.equal(regenerated.status,200,JSON.stringify(await regenerated.clone().json()));
    const replacement=await regenerated.json();
    assert.ok(Array.isArray(replacement.backupCodes)&&replacement.backupCodes.length>0);
    assert.ok(!replacement.backupCodes.includes(backupCode));
  }finally{Date.now=currentTime;}
  process.env.VERCEL='1';
  try{
    let last:Response|undefined;
    for(let attempt=1;attempt<=7;attempt++)last=await post(oldJar,'two-factor/verify-totp',{code:'000000'},`198.51.100.${attempt}`);
    assert.equal(last?.status,429);
    assert.ok(Number(last?.headers.get('Retry-After'))>0);
  }finally{delete process.env.VERCEL;}
});
