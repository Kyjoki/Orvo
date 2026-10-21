import test from 'node:test';
import assert from 'node:assert/strict';
import { hashWatchToken, newWatchToken, requireWatchConnection } from '../src/server/watch-connection';

test('ключ расширения длинный, уникальный и не хранится в открытом виде', () => {
  const first = newWatchToken();
  const second = newWatchToken();
  assert.match(first, /^orvo_watch_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.notEqual(hashWatchToken(first), first);
  assert.notEqual(hashWatchToken(first), hashWatchToken(second));
});

test('ошибочный Bearer отклоняется до обращения к базе', async () => {
  await assert.rejects(requireWatchConnection('test', 'Bearer wrong'), {
    code: 'WATCH_UNAUTHORIZED', status: 401,
  });
});
