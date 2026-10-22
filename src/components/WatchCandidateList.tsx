'use client';

import { useCallback, useEffect, useState } from 'react';

type Candidate = {
  eventId: string; observedAt: string; chatTitle: string; excerpts: string[]; pinned: boolean;
  reason: string; status: string; label: 'important' | 'noise' | null;
};

const statusLabels: Record<string, string> = {
  delivered: 'Уведомление доставлено', queued: 'В очереди Telegram',
  ignored: 'Без уведомления', duplicate: 'Повтор', 'limit-reached': 'Лимит анализа',
  failed: 'Ошибка доставки', error: 'Ошибка обработки', processing: 'Обрабатывается',
  stale: 'Устарело', disabled: 'Передача выключена',
};

export default function WatchCandidateList() {
  const [items, setItems] = useState<Candidate[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (offset = 0) => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/watch/candidates?offset=${offset}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Не удалось загрузить кандидатов.');
      setItems((previous) => offset ? [...previous, ...data.items] : data.items);
      setHasMore(data.hasMore);
      setLoaded(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function rate(eventId: string, label: Candidate['label']) {
    if (!label) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/watch/candidates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, label }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Не удалось сохранить оценку.');
      setItems((previous) => previous.map((item) => item.eventId === eventId ? { ...item, label } : item));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="watch-candidates">
    <div className="watch-candidates-heading">
      <div><h3>Кандидаты за 24 октября</h3><p className="subtle">Только новые события, которые расширение отберёт и передаст в Orvo. Доступны семь дней, затем удаляются. Оценки помогают следующим проверкам ИИ.</p></div>
      <button type="button" className="button secondary" disabled={busy} onClick={() => void load()}>Обновить</button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {loaded && items.length === 0 && <p className="subtle">Пока кандидатов нет. Запись начнётся 24 октября по времени рабочего пространства, если передача расширения включена.</p>}
    <div className="watch-candidates-list">{items.map((item) => <article className="watch-candidate" key={item.eventId}>
      <div className="watch-candidate-meta"><strong>{item.chatTitle}</strong><time dateTime={item.observedAt}>{new Date(item.observedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div>
      <p className="subtle">{item.reason === 'mention' ? 'Вас упомянули' : item.pinned ? 'Закреплённый чат' : 'Новый кандидат'} · {statusLabels[item.status] || item.status}</p>
      {item.excerpts.map((part, index) => <p className="watch-candidate-text" key={index}>{part}</p>)}
      <div className="watch-candidate-actions">
        <button type="button" className={`button secondary ${item.label === 'important' ? 'selected' : ''}`} aria-pressed={item.label === 'important'} disabled={busy} onClick={() => void rate(item.eventId, 'important')}>Стоило уведомить</button>
        <button type="button" className={`button secondary ${item.label === 'noise' ? 'selected' : ''}`} aria-pressed={item.label === 'noise'} disabled={busy} onClick={() => void rate(item.eventId, 'noise')}>Не стоило</button>
      </div>
    </article>)}</div>
    {hasMore && <button type="button" className="button secondary" disabled={busy} onClick={() => void load(items.length)}>Показать ещё</button>}
  </section>;
}
