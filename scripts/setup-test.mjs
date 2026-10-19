import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
if(existsSync('.env.local')) throw new Error('.env.local уже существует: сохранён без изменений. Для теста используйте отдельную копию проекта.');
await mkdir('.orvo',{recursive:true});
const password=randomBytes(24).toString('base64url');
await writeFile('.env.local',`ORVO_TEST_MODE=1\nBETTER_AUTH_URL=http://127.0.0.1:3000\nBETTER_AUTH_SECRET=${randomBytes(48).toString('base64url')}\nORVO_RUNTIME_SECRET=${randomBytes(48).toString('base64url')}\nORVO_RUNTIME_URL=http://127.0.0.1:3000\nORVO_OWNER_EMAIL=owner@orvo.test\nORVO_OWNER_NAME=Владелец Orvo\nORVO_OWNER_PASSWORD=${password}\n`,{flag:'wx',mode:0o600});
await writeFile('.orvo/test-access.json',JSON.stringify({email:'owner@orvo.test',password},null,2),{flag:'wx',mode:0o600});
console.log('Изолированное тестовое окружение создано. Доступ владельца: .orvo/test-access.json (не включён в Git). Выполните db:migrate и owner:create.');
