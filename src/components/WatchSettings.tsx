'use client';

import { useEffect, useState } from 'react';

type Status = { connected: boolean; createdAt: string | null };

export default function WatchSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/api/watch/connection', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Не удалось проверить подключение.');
        if (active) setStatus(data);
      })
      .catch((cause) => { if (active) setError((cause as Error).message); });
    return () => { active = false; };
  }, []);

  async function act(method: 'POST' | 'DELETE') {
    setBusy(true);
    setError('');
    setToken('');
    try {
      const response = await fetch('/api/watch/connection', { method });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Не удалось изменить подключение.');
      setStatus({ connected: data.connected, createdAt: data.createdAt });
      if (method === 'POST') setToken(data.token);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="integration-row">
    <span className="tool-icon" aria-hidden="true">◎</span>
    <div>
      <strong>Наблюдение за чатами</strong>
      <p>Отдельный отзывной ключ для расширения. Пароль Orvo и ключи ИИ ему не выдаются.</p>
      <p className="subtle">Передача рабочих сообщений и автоматические уведомления пока выключены. Ключ создавайте при подключении новой версии расширения.</p>
      <div className="inline">
        <button type="button" className="button secondary" disabled={busy} onClick={() => act('POST')}>
          {status?.connected ? 'Заменить ключ' : 'Создать ключ расширения'}
        </button>
        {status?.connected && <button type="button" className="button secondary" disabled={busy} onClick={() => act('DELETE')}>Отозвать ключ</button>}
      </div>
      {token && <><p className="subtle">Ключ показывается только сейчас. Не отправляйте его в чат.</p><input aria-label="Ключ расширения" value={token} readOnly onFocus={event => event.currentTarget.select()}/></>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <span className="chip setup">{status?.connected ? 'Ключ создан' : 'Не подключено'}</span>
  </div>;
}
