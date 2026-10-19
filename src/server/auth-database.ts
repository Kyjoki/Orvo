import { PostgresDialect } from 'kysely';
import { getDatabase, acquireEmbeddedLock } from './db';
export async function authDialect(){
  const database=await getDatabase();
  if(database.kind==='postgres')return new PostgresDialect({pool:database.pool});
  // Kysely's standard PostgreSQL driver over the isolated embedded test DB.
  // Acquiring one shared lock prevents auth SQL interleaving a domain transaction.
  const pool={
    async connect(){
      const release=await acquireEmbeddedLock();
      return {
        async query(sql:string,parameters:unknown[]=[]){const result=await database.db.query(sql,parameters);return{rows:result.rows,rowCount:result.affectedRows||result.rows.length,command:sql.trim().split(/\s+/)[0].toUpperCase()};},
        release, on(){}, removeListener(){}
      };
    },async end(){}
  };
  return new PostgresDialect({pool:pool as any});
}
