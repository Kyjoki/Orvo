import { getAuth } from './auth';
import { getWorkspace, bindWorkspaceOwner } from './domain';
export async function createOwner(email:string,password:string,name:string) {
  if (!email.includes('@') || password.length<12) throw new Error('Email и пароль длиной не менее 12 символов обязательны.');
  const workspace=await getWorkspace();
  if (workspace.ownerId) throw new Error('Владелец уже настроен. Публичное создание второго владельца запрещено.');
  const auth=await getAuth(); const context=await auth.$context;
  const user=await context.internalAdapter.createUser({email,name,emailVerified:true},{method:'admin'});
  await context.internalAdapter.createAccount({userId:user.id,providerId:'credential',accountId:user.id,password:await context.password.hash(password)});
  await bindWorkspaceOwner(user.id,email);
  return user;
}
