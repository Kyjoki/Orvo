import { query } from './db';
import { DomainError } from '../shared/types';
import { createHash } from 'node:crypto';

type BotResult<T> = { ok: boolean; result?: T };
type TelegramUpdate = {
  update_id: number;
  message?: { text?: string; chat?: { id: number | string; type?: string } };
};

const codePattern = /^[a-f0-9]{24}$/;
const chatIdPattern = /^-?\d{1,20}$/;

function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new DomainError('TELEGRAM_NOT_CONFIGURED', 'Добавьте TELEGRAM_BOT_TOKEN в закрытые переменные сервера.', 503);
  return token;
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

async function botRequest<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const token = botToken();
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    const value = await response.json() as BotResult<T>;
    if (!response.ok || !value.ok || value.result === undefined) throw new Error('Telegram API rejected request');
    return value.result;
  } catch {
    // Bot API responses and request URLs may contain sensitive details.
    throw new DomainError('TELEGRAM_UNAVAILABLE', 'Telegram не ответил. Проверьте токен бота и повторите.', 502);
  }
}

export function findPairingChat(updates: TelegramUpdate[], code: string): string | null {
  if (!codePattern.test(code)) return null;
  for (const update of updates) {
    const chat = update.message?.chat;
    const chatId = String(chat?.id ?? '');
    if (chat?.type === 'private' && chatIdPattern.test(chatId) && update.message?.text?.trim() === `/start ${code}`) {
      return chatId;
    }
  }
  return null;
}

export async function telegramStatus(workspaceId: string) {
  const row = (await query<{ bot_username: string; token_hash: string; paired_at: Date; last_test_at: Date | null }>(
    'SELECT bot_username,token_hash,paired_at,last_test_at FROM telegram_connections WHERE workspace_id=$1', [workspaceId]
  )).rows[0];
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const paired = Boolean(row && token && row.token_hash === tokenHash(token));
  return {
    tokenConfigured: Boolean(token),
    paired,
    tested: paired && Boolean(row?.last_test_at),
    botUsername: paired ? row?.bot_username ?? null : null,
    pairedAt: paired ? row?.paired_at ?? null : null,
    lastTestAt: paired ? row?.last_test_at ?? null : null,
  };
}

export async function pairTelegram(workspaceId: string, code: string) {
  if (!codePattern.test(code)) throw new DomainError('INVALID_PAIRING_CODE', 'Создайте новый код подключения.', 400);
  const bot = await botRequest<{ username?: string }>('getMe', {});
  if (!bot.username || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username)) {
    throw new DomainError('TELEGRAM_UNAVAILABLE', 'Не удалось определить имя бота.', 502);
  }
  const updates = await botRequest<TelegramUpdate[]>('getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message'] });
  const chatId = findPairingChat(updates, code);
  if (!chatId) throw new DomainError('TELEGRAM_PAIRING_PENDING', 'Отправьте боту команду с кодом и повторите проверку.', 404);
  await query(`INSERT INTO telegram_connections(workspace_id,chat_id,bot_username,token_hash)
    VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id) DO UPDATE SET
    chat_id=EXCLUDED.chat_id,bot_username=EXCLUDED.bot_username,token_hash=EXCLUDED.token_hash,paired_at=now(),last_test_at=NULL`,
    [workspaceId, chatId, bot.username, tokenHash(botToken())]);
  return telegramStatus(workspaceId);
}

export async function sendTelegramAlert(workspaceId: string, message: string) {
  if (!message.trim() || message.length > 3500) throw new DomainError('INVALID_NOTIFICATION', 'Некорректный текст уведомления.', 400);
  const row = (await query<{ chat_id: string; token_hash: string }>('SELECT chat_id,token_hash FROM telegram_connections WHERE workspace_id=$1', [workspaceId])).rows[0];
  if (!row || row.token_hash !== tokenHash(botToken())) throw new DomainError('TELEGRAM_NOT_PAIRED', 'Сначала привяжите Telegram-чат к текущему боту.', 400);
  await botRequest('sendMessage', {
    chat_id: row.chat_id,
    text: message,
    link_preview_options: { is_disabled: true },
  });
}

export async function sendTelegramTest(workspaceId: string) {
  await sendTelegramAlert(workspaceId, 'Orvo: Telegram подключён. Это проверочное уведомление.');
  await query('UPDATE telegram_connections SET last_test_at=now() WHERE workspace_id=$1', [workspaceId]);
  return telegramStatus(workspaceId);
}

export async function disconnectTelegram(workspaceId: string) {
  await query('DELETE FROM telegram_connections WHERE workspace_id=$1', [workspaceId]);
  return telegramStatus(workspaceId);
}
