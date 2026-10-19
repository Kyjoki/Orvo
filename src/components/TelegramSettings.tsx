'use client';

import { useEffect, useState } from 'react';

type TelegramStatus = {
  tokenConfigured: boolean;
  paired: boolean;
  tested: boolean;
  botUsername: string | null;
  pairedAt: string | null;
  lastTestAt: string | null;
};

export default function TelegramSettings() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/api/telegram', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Не удалось проверить Telegram.');
        if (active) setStatus(data);
      })
      .catch((cause) => { if (active) setError((cause as Error).message); });
    return () => { active = false; };
  }, []);

  async function act(action: 'pair' | 'test' | 'disconnect') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'pair' ? { action, code } : { action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Действие не выполнено.');
      setStatus(data);
      if (action === 'pair') { setCode(''); setNotice('Чат привязан. Теперь проверьте доставку.'); }
      if (action === 'test') setNotice('Проверочное уведомление отправлено в Telegram.');
      if (action === 'disconnect') setNotice('Telegram-чат отвязан.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="integration-row">
    <span className="tool-icon" aria-hidden="true">✈</span>
    <div>
      <strong>Telegram</strong>
      <p>{!status ? 'Проверка подключения…' : !status.tokenConfigured ? 'Требуется серверный токен отдельного бота Orvo.' : status.paired ? `Привязан бот @${status.botUsername}.` : 'Токен установлен. Привяжите личный чат с ботом.'}</p>
      {status?.tokenConfigured && !status.paired && <div>
        <p className="subtle">Откройте нового бота в Telegram. Создайте код и отправьте ему команду в личном чате.</p>
        {!code ? <button type="button" className="button secondary" onClick={() => setCode(crypto.randomUUID().replaceAll('-', '').slice(0, 24))}>Создать код</button>
          : <><p className="mono preserve-text">/start {code}</p><button type="button" className="button secondary" disabled={busy} onClick={() => act('pair')}>Проверить и привязать</button></>}
      </div>}
      {status?.paired && status.tokenConfigured && <div className="inline">
        <button type="button" className="button secondary" disabled={busy} onClick={() => act('test')}>Проверить отправку</button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => act('disconnect')}>Отвязать чат</button>
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="success-text" role="status">{notice}</p>}
      <p className="subtle">Пока отправляется только проверочное сообщение. Уведомления о WhatsApp появятся после подключения источника сообщений.</p>
    </div>
    <span className={`chip ${status?.tested ? 'idle' : 'setup'}`}>{status?.tested ? 'Отправка проверена' : status?.paired ? 'Ожидает проверки' : 'Требуется настройка'}</span>
  </div>;
}
