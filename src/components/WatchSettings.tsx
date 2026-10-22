'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Status = { connected: boolean; createdAt: string | null; dataTransferEnabled: boolean; mentionTransferEnabled: boolean; usage: {
  period: string; analyzed: number; eventLimit: number; accountedMicroUsd: number; budgetMicroUsd: number;
}; alerts: { pending: number; delivered: number; expired: number; dead: number };
agent: { id: string; name: string; instructionVersion: number } | null };
type Feedback = { id: string; label: 'important' | 'noise'; example: string; createdAt: string };

export default function WatchSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState('');
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  const [feedbackNote, setFeedbackNote] = useState('');
  const [feedbackLabel, setFeedbackLabel] = useState<Feedback['label']>('important');

  const loadFeedback = useCallback(async () => {
    const response = await fetch('/api/watch/feedback', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Не удалось загрузить оценки.');
    setFeedback(data.examples);
  }, []);

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

  useEffect(() => { loadFeedback().catch((cause) => setFeedbackError((cause as Error).message)); }, [loadFeedback]);

  async function saveFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedbackBusy(true);
    setFeedbackError('');
    try {
      const response = await fetch('/api/watch/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: feedbackLabel, example: feedbackNote.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Не удалось сохранить оценку.');
      setFeedbackNote('');
      await loadFeedback();
    } catch (cause) { setFeedbackError((cause as Error).message); }
    finally { setFeedbackBusy(false); }
  }

  async function removeFeedback(id: string) {
    setFeedbackBusy(true);
    setFeedbackError('');
    try {
      const response = await fetch('/api/watch/feedback', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Не удалось удалить оценку.');
      await loadFeedback();
    } catch (cause) { setFeedbackError((cause as Error).message); }
    finally { setFeedbackBusy(false); }
  }

  async function act(method: 'POST' | 'DELETE') {
    setBusy(true);
    setError('');
    setToken('');
    try {
      const response = await fetch('/api/watch/connection', { method });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Не удалось изменить подключение.');
      setStatus(data);
      if (method === 'POST') setToken(data.token);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function testWatch(kind: 'analysis' | 'mention' = 'analysis') {
    setBusy(true);
    setError('');
    setTestResult('');
    try {
      const response = await fetch(kind === 'mention' ? '/api/watch/test?kind=mention' : '/api/watch/test', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Проверка не удалась.');
      const outcomes: Record<string, string> = {
        delivered: 'Вымышленное обращение обработано, Telegram подтвердил отправку уведомления.',
        queued: 'Вымышленное обращение обработано, уведомление ожидает доставки.',
        ignored: 'Модель обработала вымышленное обращение, но не выбрала уведомление.',
        failed: 'Модель обработала вымышленное обращение, но доставка не удалась.',
      };
      const mentionOutcomes: Record<string, string> = {
        delivered: 'Тестовое упоминание доставлено в Telegram.',
        queued: 'Тестовое упоминание ожидает доставки.',
        failed: 'Тестовое упоминание не доставлено.',
      };
      setTestResult(kind === 'mention'
        ? mentionOutcomes[data.status] || `Проверка упоминания: ${data.status}.`
        : outcomes[data.status] || `Проверка завершилась со статусом: ${data.status}.`);
      try {
        const latest = await fetch('/api/watch/connection', { cache: 'no-store' });
        if (latest.ok) setStatus(await latest.json());
      } catch { /* The completed test result remains authoritative if counters cannot refresh. */ }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="integration-row">
    <span className="tool-icon" aria-hidden="true">◎</span>
    <div>
      <strong>Наблюдение за чатами</strong>
      <p>Отдельный отзывной ключ для расширения. Пароль Orvo и ключи ИИ ему не выдаются.</p>
      {status && <p className="subtle">{status.agent
        ? `Профиль наблюдателя: ${status.agent.name}, инструкции v${status.agent.instructionVersion}. Анализ использует отдельную модель и не запускает обычные задачи агента.`
        : 'Профиль наблюдателя ещё не связан с обработчиком сообщений.'}</p>}
      <p className="subtle">{status?.dataTransferEnabled
        ? 'Приём включён и основные настройки найдены. Доступность модели и доставка Telegram подтвердятся только проверочным событием. Передачу нужно отдельно включить в расширении.'
        : status?.mentionTransferEnabled
          ? 'Лимит анализа ИИ достигнут или модель недоступна. Явные упоминания продолжают передаваться в Telegram без анализа ИИ.'
        : 'Приём новых сообщений сейчас недоступен. Уведомления, уже поставленные в очередь, могут ещё доставляться; их число показано ниже. Ключ создавайте при подключении новой версии расширения.'}</p>
      {status?.usage && <p className="subtle">Анализов за {status.usage.period}: {status.usage.analyzed} из {status.usage.eventLimit}. Учтено с резервом: ${(status.usage.accountedMicroUsd / 1_000_000).toFixed(3)} из ${(status.usage.budgetMicroUsd / 1_000_000).toFixed(0)}.</p>}
      {status?.alerts && <p className="subtle">Telegram за месяц: доставлено {status.alerts.delivered}, ожидает {status.alerts.pending}, не доставлено {status.alerts.dead + status.alerts.expired}.</p>}
      <div className="inline">
        <button type="button" className="button secondary" disabled={busy} onClick={() => act('POST')}>
          {status?.connected ? 'Заменить ключ' : 'Создать ключ расширения'}
        </button>
        {status?.connected && <button type="button" className="button secondary" disabled={busy} onClick={() => act('DELETE')}>Отозвать ключ</button>}
      </div>
      {status?.dataTransferEnabled && <>
        <p className="subtle">Проверка использует только вымышленное обращение, один анализ из месячного лимита и ваш привязанный Telegram.</p>
        <button type="button" className="button secondary" disabled={busy} onClick={() => testWatch('analysis')}>Проверить анализ и Telegram</button>
      </>}
      {status?.mentionTransferEnabled && <button type="button" className="button secondary" disabled={busy} onClick={() => testWatch('mention')}>Проверить упоминание в Telegram</button>}
      {token && <><p className="subtle">Ключ показывается только сейчас. Не отправляйте его в чат.</p><input aria-label="Ключ расширения" value={token} readOnly onFocus={event => event.currentTarget.select()}/></>}
      {testResult && <p role="status">{testResult}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="watch-feedback">
        <h3>Учить на примерах</h3>
        <p className="subtle">Опиши короткий пример без имён и номеров и отметь, стоило ли уведомлять. Следующие проверки ИИ учтут до трёх наиболее похожих оценок каждого типа. Явные упоминания отправляются отдельно от ИИ.</p>
        <form onSubmit={saveFeedback}>
          <label className="field"><span>Оценка</span><select value={feedbackLabel} onChange={(event) => setFeedbackLabel(event.target.value as Feedback['label'])}>
            <option value="important">Важно — уведомлять</option><option value="noise">Лишнее — не уведомлять</option>
          </select></label>
          <label className="field"><span>Пример ситуации</span><textarea value={feedbackNote} onChange={(event) => setFeedbackNote(event.target.value)} minLength={12} maxLength={1000} rows={3} placeholder="Например: клиент просит срочно проверить терминал, оплата не проходит" required/></label>
          <button type="submit" className="button secondary" disabled={feedbackBusy || feedback.length >= 100}>Сохранить оценку</button>
        </form>
        {feedbackError && <p className="form-error" role="alert">{feedbackError}</p>}
        {feedback.length > 0 && <ul>{feedback.map((item) => <li key={item.id}>
          <strong>{item.label === 'important' ? 'Важно' : 'Лишнее'}</strong> · {item.example}{' '}
          <button type="button" className="button secondary" disabled={feedbackBusy} onClick={() => removeFeedback(item.id)}>Удалить</button>
        </li>)}</ul>}
      </div>
    </div>
    <span className="chip setup">{status?.connected ? 'Ключ создан' : 'Не подключено'}</span>
  </div>;
}
