import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
process.env.ORVO_TEST_MODE='1';delete process.env.DATABASE_URL;delete process.env.ORVO_TEST_DB_DIR;
process.env.ORVO_TEST_DB_NAME=`custom-${process.pid}-${randomUUID().slice(0,8)}`;
process.env.ORVO_WORKSPACE_ID=`custom-${process.pid}`;
const domain=await import('../src/server/domain');
const {getDatabase}=await import('../src/server/db');
const workspace=await domain.getWorkspace();
const command=(type:string,payload:any={})=>domain.command(workspace.id,type,payload,randomUUID());
after(async()=>{const database=await getDatabase();if(database.kind==='pglite')await database.db.close();});
test('an empty office stays empty and arbitrary owner roles can receive tasks',async()=>{
 assert.equal((await domain.getSnapshot(workspace.id)).agents.length,0);
 await assert.rejects(command('task.create',{title:'Первая задача'}),(error:any)=>error.code==='NO_AGENT');
 const library=await command('agents.create',{name:'Книголюб',role:'Куратор библиотеки',description:'Каталоги библиотеки и книги',instructions:'Работай с предоставленным каталогом.'});
 const music=await command('agents.create',{name:'Лира',role:'Музыкальный редактор',description:'Музыкальные подборки',instructions:'Готовь подборки по запросу владельца.'});
 const snapshot=await domain.getSnapshot(workspace.id);assert.equal(snapshot.agents.length,2);assert.ok(snapshot.agents.every(agent=>agent.roleKey.startsWith('custom-')));
 const task=await command('task.create',{title:'Подготовь каталог библиотеки'});assert.equal((await domain.getTask(task.id)).agentId,library.id);
 await command('task.cancel',{id:task.id});await command('agents.archive',{id:library.id});
 const fallback=await command('task.create',{title:'Новая задача'});assert.equal((await domain.getTask(fallback.id)).agentId,music.id);
 assert.equal((await domain.getSnapshot(workspace.id)).agents.length,2,'archived profiles are preserved');
});
test('legacy developer profiles are a test fixture, disabled for the real product',async()=>{
 const before=(await domain.getSnapshot(workspace.id)).agents.length;
 process.env.ORVO_TEST_MODE='0';
 try{await assert.rejects(command('agents.seed'),(error:any)=>error.code==='TEST_FIXTURE_DISABLED');}
 finally{process.env.ORVO_TEST_MODE='1';}
 assert.equal((await domain.getSnapshot(workspace.id)).agents.length,before);
});
