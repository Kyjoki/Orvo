import { createOwner } from '../src/server/owner';
import { getDatabase } from '../src/server/db';
const {ORVO_OWNER_EMAIL,ORVO_OWNER_PASSWORD,ORVO_OWNER_NAME}=process.env;
if(!ORVO_OWNER_EMAIL||!ORVO_OWNER_PASSWORD) throw new Error('Задайте ORVO_OWNER_EMAIL и ORVO_OWNER_PASSWORD в окружении процесса (не в Git).');
await createOwner(ORVO_OWNER_EMAIL,ORVO_OWNER_PASSWORD,ORVO_OWNER_NAME||'Владелец Orvo');
console.log('Владелец создан. Публичной регистрации нет.');
const database=await getDatabase();if(database.kind==='pglite')await database.db.close();else await database.pool.end();
