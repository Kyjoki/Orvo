export const ACTIVE_AGENT_TASK_STATUSES=['running','pause_requested','cancel_requested','waiting_for_approval','waiting_for_input','paused','retry_scheduled','queued','scheduled'] as const;
export function currentAgentTask<T extends {agentId:string;status:string;setupRequired?:boolean}>(tasks:T[],agentId:string):T|undefined{
 for(const status of ACTIVE_AGENT_TASK_STATUSES){const task=tasks.find(task=>task.agentId===agentId&&task.status===status&&!task.setupRequired);if(task)return task;}
}
