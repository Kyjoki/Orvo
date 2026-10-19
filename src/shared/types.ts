// Product roles are defined by the owner, independently of the development team.
export type RoleKey = string;
export const TASK_STATUSES = ['draft','scheduled','queued','running','waiting_for_input','waiting_for_approval','pause_requested','paused','retry_scheduled','ready_for_review','completed','failed','cancel_requested','cancelled'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export interface Agent { id:string; workspaceId:string; roleKey:string; name:string; role:string; description:string; color:string; avatar:string; instructions:string; instructionVersion:number; model:string|null; permissions:Record<string,string>; limits:{maxSteps:number;maxTokens:number;maxOutputTokens:number}; archived:boolean; version:number; status:string; [key:string]:any }
export interface Task { id:string; workspaceId:string; agentId:string; title:string; description:string; status:TaskStatus; version:number; revision:number; teamPlan:string[]; maxSteps:number; maxTokens:number; workflowRunId?:string; createdAt:string; updatedAt:string; [key:string]:any }
export interface MemoryRecord { id:string; workspaceId:string; agentId?:string|null; projectId?:string|null; scope:'workspace'|'project'|'agent'; text:string; type:string; source:string; active:boolean; version:number; [key:string]:any }
export interface Snapshot { workspace:any; settings:any; agents:Agent[]; tasks:Task[]; memories:MemoryRecord[]; messages:any[]; approvals:any[]; artifacts:any[]; notifications:any[]; events:any[]; usage:any[]; [key:string]:any }
export class DomainError extends Error { constructor(public code:string,message:string,public status=400){super(message);this.name='DomainError';} }
