import { runtimeOrigin } from './server/runtime-origin';

export async function register(){
 // Serverless instances do not stay alive to provide an outbox scheduler.
 if(process.env.VERCEL||process.env.NEXT_RUNTIME!=='nodejs'||!process.env.ORVO_RUNTIME_SECRET)return;
 // A persistent Node host retries durable outbox delivery independently of tabs.
 // API owns DB access; instrumentation never opens a second embedded database.
 const state=process as typeof process&{__orvoDispatcher?:ReturnType<typeof setInterval>};
 if(state.__orvoDispatcher)return;
 let active=false;
 const tick=async()=>{if(active)return;active=true;try{
   await fetch(new URL('/api/runtime/drain',runtimeOrigin()),{method:'POST',headers:{authorization:`Bearer ${process.env.ORVO_RUNTIME_SECRET}`},signal:AbortSignal.timeout(30000)});
 }catch{/* Startup/restart retries on the next tick; no credentials or payload logged. */}finally{active=false;}};
 state.__orvoDispatcher=setInterval(tick,10000);state.__orvoDispatcher.unref();
}
