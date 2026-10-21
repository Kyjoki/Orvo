import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WATCH_AGENT_INSTRUCTIONS, formatWatchTelegram, parseWatchDecision,
  redactWatchText, shouldNotifyWatch, watchPrompt,
} from '../src/server/watch-triage';

test('контактные данные и ссылки не попадают в запрос и Telegram', () => {
  const candidate = {
    chatTitle: 'Клиент +70000000000', pinned: true,
    excerpts: ['Перезвоните +7 (700) 000-00-00, ссылка https://example.test/private?token=secret'],
  };
  const prompt = watchPrompt(candidate);
  assert.doesNotMatch(prompt, /70000000000|example\.test|token=secret/);
  assert.match(prompt, /номер скрыт/);
  const result = formatWatchTelegram(candidate, {
    priority: 'action', confidence: 0.9,
    summary: 'Нужно проверить терминал. Контакт: test@example.test', reason: 'Просьба клиента',
  });
  assert.equal(result?.includes('test@example.test'), false);
  assert.equal(result?.includes('70000000000'), false);
});

test('неуверенное решение и шум не создают уведомление', () => {
  assert.equal(shouldNotifyWatch({ priority: 'ignore', confidence: 1, summary: 'Выдали роль', reason: '' }), false);
  assert.equal(shouldNotifyWatch({ priority: 'action', confidence: 0.6, summary: 'Возможно просьба', reason: '' }), false);
  assert.equal(shouldNotifyWatch({ priority: 'urgent', confidence: 0.95, summary: 'Терминал не работает', reason: '' }), true);
});

test('ответ модели строго ограничен схемой, чат не может выдать инструмент', () => {
  assert.throws(() => parseWatchDecision(JSON.stringify({ priority: 'urgent', confidence: 1, summary: 'Проблема', reason: '', tool: 'sendWhatsapp' })));
  assert.match(WATCH_AGENT_INSTRUCTIONS, /не пиши в рабочие чаты/u);
  assert.equal(redactWatchText('https://chat.whatsapp.com/abc'), '[ссылка скрыта]');
  assert.equal(redactWatchText('Bearer abcdefghijklmnopqrstuvwxyz123456'), '[секрет скрыт]');
  assert.equal(redactWatchText('sk-abcdefghijklmnopqrstuvwxyz123456'), '[секрет скрыт]');
});
