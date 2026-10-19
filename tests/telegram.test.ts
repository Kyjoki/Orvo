import test from 'node:test';
import assert from 'node:assert/strict';
import { findPairingChat } from '../src/server/telegram';

const code = '0123456789abcdef01234567';

test('Telegram pairing accepts only a matching private /start command', () => {
  assert.equal(findPairingChat([
    { update_id: 1, message: { text: `/start ${code}`, chat: { id: -100123, type: 'supergroup' } } },
    { update_id: 2, message: { text: '/start wrong', chat: { id: 123, type: 'private' } } },
    { update_id: 3, message: { text: `/start ${code}`, chat: { id: 456, type: 'private' } } },
  ], code), '456');
});

test('Telegram pairing rejects malformed codes and unrelated messages', () => {
  const updates = [{ update_id: 1, message: { text: `/start ${code}`, chat: { id: 456, type: 'private' } } }];
  assert.equal(findPairingChat(updates, 'short'), null);
  assert.equal(findPairingChat(updates, 'aaaaaaaaaaaaaaaaaaaaaaaa'), null);
  assert.equal(findPairingChat([{ update_id: 1, message: { text: `/start ${code}`, chat: { id: 'bad-id', type: 'private' } } }], code), null);
});
