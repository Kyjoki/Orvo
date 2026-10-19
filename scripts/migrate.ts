import { migrate, getDatabase } from '../src/server/db';
import { getAuth } from '../src/server/auth';
import { getMigrations } from 'better-auth/db/migration';
// Marketplace Neon supplies a direct URL for administrative schema work.
if(process.env.DATABASE_URL_UNPOOLED)process.env.DATABASE_URL=process.env.DATABASE_URL_UNPOOLED;
await migrate();
const auth=await getAuth();
await (await getMigrations(auth.options)).runMigrations();
console.log('Миграции домена и авторизации применены.');
const database=await getDatabase();if(database.kind==='pglite')await database.db.close();else await database.pool.end();
