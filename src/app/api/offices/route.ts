import { z } from 'zod';
import { archiveOwnerWorkspace, createOwnerWorkspace, getWorkspaceForOwner, listArchivedOwnerWorkspaces, listOwnerWorkspaces, permanentlyDeleteArchivedWorkspace, renameOwnerWorkspace, restoreOwnerWorkspace } from '@/server/domain';
import { assertOrigin, failure, readJson, requireOwner, requireOwnerSession } from '@/server/http';
import { consumeRateLimit, rateLimitFailure } from '@/server/rate-limit';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const schema=z.discriminatedUnion('action',[
  z.object({action:z.literal('switch'),workspaceId:z.string().min(1).max(100)}),
  z.object({action:z.literal('create'),name:z.string().trim().min(1).max(60)}),
  z.object({action:z.literal('rename'),name:z.string().trim().min(1).max(60)}),
  z.object({action:z.literal('restore'),workspaceId:z.string().min(1).max(100)}),
]);
const deleteSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('archive'),workspaceId:z.string().min(1).max(100),confirmName:z.string().min(1).max(60)}),
  z.object({action:z.literal('purge'),workspaceId:z.string().min(1).max(100),confirmName:z.string().min(1).max(60)}),
]);

function selectedOfficeCookie(id:string){
  const secure=process.env.NODE_ENV==='production'?'; Secure':'';
  return `orvo-office=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`;
}

export async function GET(request:Request){
  try{
    const{session,workspace}=await requireOwnerSession(request);
    return Response.json({offices:await listOwnerWorkspaces(session.user.id),archivedOffices:await listArchivedOwnerWorkspaces(session.user.id),activeOfficeId:workspace.id},{headers:{'Cache-Control':'no-store'}});
  }catch(error){return failure(error);}
}

export async function POST(request:Request){
  try{
    assertOrigin(request);
    const{session,workspace}=await requireOwner(request);
    await consumeRateLimit('offices-write-owner',session.user.id,30,60);
    const input=schema.parse(await readJson(request,4096));
    const selected=input.action==='switch'
      ? await getWorkspaceForOwner(session.user.id,input.workspaceId)
      : input.action==='create'
        ? await createOwnerWorkspace(session.user.id,input.name)
        : input.action==='rename'
          ? await renameOwnerWorkspace(session.user.id,workspace.id,input.name)
          : await restoreOwnerWorkspace(session.user.id,input.workspaceId);
    return Response.json({ok:true,workspace:{id:selected.id,name:selected.name,officeDesign:selected.officeDesign},offices:await listOwnerWorkspaces(session.user.id),archivedOffices:await listArchivedOwnerWorkspaces(session.user.id)},{headers:{'Cache-Control':'no-store','Set-Cookie':selectedOfficeCookie(selected.id)}});
  }catch(error){return rateLimitFailure(error)??failure(error);}
}

export async function DELETE(request:Request){
  try{
    assertOrigin(request);
    const{session,workspace}=await requireOwner(request);
    await consumeRateLimit('offices-write-owner',session.user.id,30,60);
    const input=deleteSchema.parse(await readJson(request,4096));
    if(input.action==='purge')await permanentlyDeleteArchivedWorkspace(session.user.id,input.workspaceId,input.confirmName);
    else await archiveOwnerWorkspace(session.user.id,input.workspaceId,input.confirmName);
    const offices=await listOwnerWorkspaces(session.user.id);
    const selected=offices.some(office=>office.id===workspace.id)
      ? workspace
      : await getWorkspaceForOwner(session.user.id,offices[0].id);
    return Response.json({ok:true,offices,archivedOffices:await listArchivedOwnerWorkspaces(session.user.id),activeOfficeId:selected.id},{headers:{'Cache-Control':'no-store','Set-Cookie':selectedOfficeCookie(selected.id)}});
  }catch(error){return rateLimitFailure(error)??failure(error);}
}
