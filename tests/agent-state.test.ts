import {test} from 'node:test';
import assert from 'node:assert/strict';
import {currentAgentTask} from '../src/shared/agent-state';
test('agent state reflects running or waiting work instead of an older review result',()=>{
 const tasks=[{id:'review',agentId:'a',status:'ready_for_review'},{id:'queued',agentId:'a',status:'queued'},{id:'input',agentId:'a',status:'waiting_for_input'}];
 assert.equal(currentAgentTask(tasks,'a')?.id,'input');
 assert.equal(currentAgentTask([...tasks,{id:'running',agentId:'a',status:'running'}],'a')?.id,'running');
 assert.equal(currentAgentTask([tasks[0]],'a'),undefined);
 assert.equal(currentAgentTask([{id:'setup',agentId:'a',status:'waiting_for_input',setupRequired:true}],'a'),undefined);
});
