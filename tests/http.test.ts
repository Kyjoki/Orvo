import {test} from 'node:test';
import assert from 'node:assert/strict';
import {failure,readJson} from '../src/server/http';
import {DomainError} from '../src/shared/types';
test('system error codes cannot expose SQL or private filesystem paths',async()=>{
 for(const code of ['ENOENT','42P01']){const response=failure(Object.assign(new Error('private connection and internal path'),{code}));const body=await response.text();assert.ok(!body.includes('private connection'));assert.ok(!body.includes(code));}
 const body=await failure(new DomainError('NOT_FOUND','Безопасное сообщение',404)).json();assert.equal(body.error.code,'NOT_FOUND');
});
test('streaming JSON limit applies without Content-Length and cancels the reader',async()=>{
 let cancelled=false;const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(2048));},cancel(){cancelled=true;}});
 const request=new Request('http://localhost/api/command',{method:'POST',body:stream,duplex:'half'} as RequestInit);
 await assert.rejects(readJson(request,1024),(error:any)=>error.code==='BODY_TOO_LARGE'&&error.status===413);assert.equal(cancelled,true);
});
test('JSON parser rejects invalid UTF-8 and accepts bounded valid input',async()=>{
 const valid=new Request('http://localhost',{method:'POST',body:'{"ok":true}'});assert.deepEqual(await readJson(valid,100),{ok:true});
 const invalid=new Request('http://localhost',{method:'POST',body:new Uint8Array([255,255])});await assert.rejects(readJson(invalid,100),(error:any)=>error.code==='INVALID_JSON');
});
