// Local test database host. Keeps PostgreSQL WASM outside Next.js VM contexts.
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite(process.argv[2]);
await db.waitReady;
process.send?.({ ready: true });
let pending = Promise.resolve();
let closing;
function close(){return closing??=pending.then(()=>db.close());}
process.on('message', message => {
  pending = pending.then(async () => {
    try {
      if (message.operation === 'close') { await db.close(); process.send?.({id:message.id,result:true}); process.disconnect(); return; }
      const result = message.operation === 'exec'
        ? await db.exec(message.sql)
        : await db.query(message.sql, message.params);
      process.send?.({ id: message.id, result });
    } catch (error) {
      process.send?.({ id: message.id, error: { message: error.message, code: error.code } });
    }
  });
});
process.on('disconnect', () => { close().finally(() => process.exit()); });
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{close().finally(()=>process.exit());});
