import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Pool, type PoolClient } from 'pg';
import { DomainError } from '../shared/types';

export interface Queryable { query<T=any>(sql:string,params?:any[]):Promise<{rows:T[];rowCount?:number|null}> }
type DatabaseState={connection?:Promise<Queryable>;initialized?:Promise<void>;mutex:Promise<any>;databaseKind:'postgres'|'pglite'};
const processGlobals=process as typeof process&{__orvoDatabase?:DatabaseState};
const state=processGlobals.__orvoDatabase??={mutex:Promise.resolve(),databaseKind:'postgres'};
async function raw():Promise<Queryable>{
  if(!state.connection) state.connection=(async()=>{
    if(!process.env.DATABASE_URL&&process.env.ORVO_TEST_MODE==='1'){
      if(process.env.VERCEL)throw new DomainError('EMBEDDED_DATABASE_NOT_ALLOWED','Тестовая локальная БД недоступна на Vercel.',500);
      if(process.env.BETTER_AUTH_URL&&!['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.BETTER_AUTH_URL).hostname))throw new DomainError('EMBEDDED_DATABASE_NOT_ALLOWED','Локальная тестовая БД доступна только на localhost.',500);
      const testName=process.env.ORVO_TEST_DB_NAME||'app';
      if(!/^[a-zA-Z0-9_-]{1,80}$/.test(testName))throw new DomainError('INVALID_TEST_DATABASE','Некорректное имя тестовой базы.',500);
      // Resolve mutable test data at runtime: never trace a private database into a Next build.
      const localRoot=Reflect.apply(process.cwd,process,[]) as string;
      const testRoot=path.resolve(localRoot,'.orvo','test-db');const directory=process.env.ORVO_TEST_DB_DIR?path.resolve(process.env.ORVO_TEST_DB_DIR):path.join(testRoot,testName);
      if(directory!==testRoot&&!directory.startsWith(testRoot+path.sep))throw new DomainError('INVALID_TEST_DATABASE','Тестовая база должна находиться внутри .orvo/test-db.',500);
      await mkdir(directory,{recursive:true});
      state.databaseKind='pglite';
      const child=spawn(process.execPath,[path.join(localRoot,'scripts','embedded-db.mjs'),directory],{stdio:['ignore','ignore','inherit','ipc']});
      let sequence=0;
      const requests=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
      const ready=new Promise<void>((resolve,reject)=>{
        child.on('message',(message:any)=>{
          if(message.ready){resolve();return;}
          const request=requests.get(message.id);if(!request)return;requests.delete(message.id);
          if(message.error)request.reject(Object.assign(new Error(message.error.message),{code:message.error.code}));else request.resolve(message.result);
        });
        child.once('error',reject);
        child.once('exit',()=>{const error=new Error('Local test database process stopped');reject(error);for(const request of requests.values())request.reject(error);requests.clear();});
      });
      await ready;
      const call=(operation:string,sql:string,params:any[]=[])=>new Promise<any>((resolve,reject)=>{const id=++sequence;requests.set(id,{resolve,reject});child.send({id,operation,sql,params},error=>{if(error){requests.delete(id);reject(error);}});});
      return {query:(sql:string,params:any[]=[])=>call('query',sql,params),exec:(sql:string)=>call('exec',sql),close:()=>call('close','')} as Queryable;
    }
    if(!process.env.DATABASE_URL) throw new DomainError('DATABASE_NOT_CONFIGURED','Настройте DATABASE_URL PostgreSQL. Тестовая БД включается только ORVO_TEST_MODE=1.',503);
    const connectionUrl=new URL(process.env.DATABASE_URL);
    // Preserve certificate + hostname verification, including future pg releases.
    if(process.env.VERCEL||['prefer','require','verify-ca'].includes(connectionUrl.searchParams.get('sslmode')||'')){
      connectionUrl.searchParams.set('sslmode','verify-full');
      connectionUrl.searchParams.delete('uselibpqcompat');
    }
    const pool=new Pool({connectionString:connectionUrl.toString(),max:5,connectionTimeoutMillis:15000,idleTimeoutMillis:30000,allowExitOnIdle:true});
    pool.on('error',()=>console.error('An idle PostgreSQL connection closed; the pool will reconnect.'));
    return pool as unknown as Queryable;
  })();
  return state.connection;
}
export async function migrate(){
  if(!state.initialized) state.initialized=(async()=>{
    const db=await raw();
    const client=state.databaseKind==='postgres'?await (db as unknown as Pool).connect():db;
    try{
      await client.query('BEGIN');
      // Transaction scoped: safe with pooled Neon connections and concurrent cold starts.
      if(state.databaseKind==='postgres')await client.query('SELECT pg_advisory_xact_lock(1869772399, 1)');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const dir=path.join(process.cwd(),'migrations');
      for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()){
        const found=await client.query('SELECT name FROM schema_migrations WHERE name=$1',[file]);
        if(!found.rows.length){const sql=await readFile(path.join(dir,file),'utf8');if(state.databaseKind==='pglite')await (client as any).exec(sql);else await client.query(sql);await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);}
      }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
    finally{if(state.databaseKind==='postgres')(client as PoolClient).release();}
  })().catch(error=>{state.initialized=undefined;throw error;});
  await state.initialized;
}
export async function acquireEmbeddedLock(){
  let release!:()=>void;
  const current=new Promise<void>(resolve=>{release=resolve;});
  const prior=state.mutex;state.mutex=current;await prior;return release;
}
export async function query<T=any>(sql:string,params:any[]=[]){
  await migrate();const db=await raw();
  if(state.databaseKind!=='pglite')return db.query<T>(sql,params);
  const release=await acquireEmbeddedLock();try{return await db.query<T>(sql,params);}finally{release();}
}
export async function getDatabase(){const db=await raw();return state.databaseKind==='pglite'?{kind:'pglite' as const,db:db as any}:{kind:'postgres' as const,pool:db as any};}
export async function transaction<T>(fn:(db:Queryable)=>Promise<T>):Promise<T>{
  await migrate();
  const run=async()=>{
    const db=await raw();
    const client=state.databaseKind==='pglite'?db:await (db as any).connect();
    try{await client.query('BEGIN'); const result=await fn(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{if('release' in client)client.release();}
  };
  if(state.databaseKind!=='pglite') return run();
  const release=await acquireEmbeddedLock();try{return await run();}finally{release();}
}
