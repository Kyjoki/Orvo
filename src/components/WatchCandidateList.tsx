'use client';

import { useCallback, useEffect, useState } from 'react';

type Candidate = {
  eventId: string; observedAt: string; chatTitle: string; excerpts: string[]; pinned: boolean;
  reason: string; status: string; label: 'important' | 'noise' | null; explanation?: string;
};

const statusLabels: Record<string, string> = {
  delivered: 'Уведомление доставлено', queued: 'В очереди Telegram',
  ignored: 'Без уведомления', duplicate: 'Повтор', 'limit-reached': 'Лимит анализа',
  failed: 'Ошибка доставки', error: 'Ошибка обработки', processing: 'Обрабатывается',
  stale: 'Устарело', disabled: 'Передача выключена',
  observed: 'Только в журнале · без ИИ и Telegram',
};

const demoCandidate: Candidate = {
  eventId: 'demo', observedAt: '2026-10-23T04:15:00.000Z',
  chatTitle: 'Тестовый чат — вымышленный',
  excerpts: ['Терминал не принимает оплату, клиенты ждут. Нужен специалист для проверки.'],
  pinned: true, reason: 'urgent', status: 'ignored', label: null,
};

function CandidateCard({ item, busy, demo = false, onRate }: {
  item: Candidate; busy: boolean; demo?: boolean;
  onRate: (label: 'important' | 'noise', explanation: string) => void;
}) {
  const [explanation, setExplanation] = useState(item.explanation || '');
  useEffect(() => { setExplanation(item.explanation || ''); }, [item.explanation]);
  return <article className="watch-candidate">
    <div className="watch-candidate-meta"><strong>{item.chatTitle}</strong><time dateTime={item.observedAt}>{new Date(item.observedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div>
    <p className="subtle">{demo ? 'Пример · не отправлялся в Telegram' : `${item.reason === 'observation' ? 'Изменение видимого превью' : item.reason === 'mention' ? 'Вас упомянули' : item.pinned ? 'Закреплённый чат' : 'Отобранный кандидат'} · ${statusLabels[item.status] || item.status}`}</p>
    {item.excerpts.map((part, index) => <p className="watch-candidate-text" key={index}>{part}</p>)}
    <label className="field watch-candidate-note"><span>Почему так считаешь? (необязательно)</span>
      <textarea value={explanation} onChange={(event) => setExplanation(event.target.value)} maxLength={400} rows={2} placeholder="Например: клиент ждёт помощи, вопрос ещё не решён"/>
      <small>Опиши обстоятельства без имён и номеров. Пояснение сохранится при нажатии на оценку.</small>
    </label>
    <div className="watch-candidate-actions">
      <button type="button" className={`button secondary ${item.label === 'important' ? 'selected' : ''}`} aria-pressed={item.label === 'important'} disabled={busy} onClick={() => onRate('important', explanation)}>Стоило уведомить</button>
      <button type="button" className={`button secondary ${item.label === 'noise' ? 'selected' : ''}`} aria-pressed={item.label === 'noise'} disabled={busy} onClick={() => onRate('noise', explanation)}>Не стоило</button>
    </div>
    {demo && <p className="subtle">Нажатие на кнопки здесь показывает выбор, но не сохраняет оценку и не обучает агента.</p>}
  </article>;
}

export default function WatchCandidateList() {
  const [items, setItems] = useState<Candidate[]>([]);
  const [demoLabel, setDemoLabel] = useState<Candidate['label']>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
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
      setTotal(data.total);
      setLoaded(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function rate(eventId: string, label: Candidate['label'], explanation: string) {
    if (!label) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/watch/candidates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, label, explanation }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Не удалось сохранить оценку.');
      setItems((previous) => previous.map((item) => item.eventId === eventId ?
        { ...item, label, explanation: data.explanation } : item));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="watch-candidates">
    <div className="watch-candidates-heading">
      <div><h3>Журнал изменений за 23 октября</h3><p className="subtle">Новые изменения видимого списка чатов и отобранные кандидаты. Изменения вне фильтра сохраняются без ИИ и Telegram. Доступны семь дней, затем удаляются. Оценки помогают следующим проверкам ИИ.</p></div>
      <button type="button" className="button secondary" disabled={busy} onClick={() => void load()}>Обновить</button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {loaded && <p className="subtle" role="status">Всего записей: {total}. Показано: {items.length}.</p>}
    {loaded && items.length === 0 && <p className="subtle">Пока изменений нет. Запись идёт сегодня по времени рабочего пространства, если передача расширения включена.</p>}
    {loaded && items.length === 0 && <CandidateCard item={{ ...demoCandidate, label: demoLabel }} busy={false} demo onRate={setDemoLabel}/>}
    {items.length > 0 && <ol className="watch-candidates-list" aria-label="Журнал изменений чатов">
      {items.map((item) => <li key={item.eventId}>
        <details className="watch-candidate-list-item" open={items.length === 1}>
          <summary>
            <span className="watch-candidate-list-top"><strong>{item.chatTitle}</strong><time dateTime={item.observedAt}>{new Date(item.observedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda', hour: '2-digit', minute: '2-digit' })}</time></span>
            <span className="watch-candidate-list-preview">{item.excerpts.at(-1)}</span>
            <span className="watch-candidate-list-status">{item.label === 'important' ? 'Стоило уведомить' : item.label === 'noise' ? 'Не стоило' : 'Не оценено'} · {statusLabels[item.status] || item.status}</span>
          </summary>
          <CandidateCard item={item} busy={busy} onRate={(label, explanation) => void rate(item.eventId, label, explanation)}/>
        </details>
      </li>)}
    </ol>}
    {hasMore && <button type="button" className="button secondary" disabled={busy} onClick={() => void load(items.length)}>Показать ещё</button>}
  </section>;
}
