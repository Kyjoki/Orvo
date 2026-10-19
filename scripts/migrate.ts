import { migrate, getDatabase } from '../src/server/db';
import { getAuth } from '../src/server/auth';
import { getMigrations } from 'better-auth/db/migration';
await migrate();
const auth=await getAuth();
await (await getMigrations(auth.options)).runMigrations();
console.log('Миграции домена и авторизации применены.');
const database=await getDatabase();if(database.kind==='pglite')await database.db.close();else await database.pool.end();
