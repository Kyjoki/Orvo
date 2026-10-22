'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Feedback = { id: string; label: 'important' | 'noise'; example: string; createdAt: string };

export default function WatchFeedback() {
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [label, setLabel] = useState<Feedback['label']>('important');

  const load = useCallback(async () => {
    const response = await fetch('/api/watch/feedback', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Не удалось загрузить оценки.');
    setFeedback(data.examples);
  }, []);

  useEffect(() => { load().catch((cause) => setError((cause as Error).message)); }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/watch/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, example: note.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Не удалось сохранить оценку.');
      setNote('');
      await load();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/watch/feedback', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Не удалось удалить оценку.');
      await load();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="panel-section watch-feedback">
    <h3>Учить на примерах</h3>
    <p className="subtle">Опиши короткий пример без имён и номеров и отметь, стоило ли уведомлять. Следующие проверки ИИ учтут до трёх наиболее похожих оценок каждого типа. Явные упоминания отправляются отдельно от ИИ.</p>
    <form onSubmit={save}>
      <label className="field"><span>Оценка</span><select value={label} onChange={(event) => setLabel(event.target.value as Feedback['label'])}>
        <option value="important">Важно — уведомлять</option><option value="noise">Лишнее — не уведомлять</option>
      </select></label>
      <label className="field"><span>Пример ситуации</span><textarea value={note} onChange={(event) => setNote(event.target.value)} minLength={12} maxLength={1000} rows={3} placeholder="Например: клиент просит срочно проверить терминал, оплата не проходит" required/></label>
      <button type="submit" className="button secondary" disabled={busy || feedback.length >= 100}>Сохранить оценку</button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    {feedback.length > 0 && <ul>{feedback.map((item) => <li key={item.id}>
      <strong>{item.label === 'important' ? 'Важно' : 'Лишнее'}</strong> · {item.example}{' '}
      <button type="button" className="button secondary" disabled={busy} onClick={() => remove(item.id)}>Удалить</button>
    </li>)}</ul>}
  </section>;
}
