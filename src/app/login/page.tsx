'use client';
import { useState } from 'react';
import styles from './login.module.css';
export default function Login() {
  const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form=new FormData(event.currentTarget);
    try {
      const response=await fetch('/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.get('email'),password:form.get('password')})});
      if(response.status===429){const seconds=Number(response.headers.get('Retry-After')||response.headers.get('X-Retry-After'));setError(`Слишком много попыток входа. ${seconds>0?`Повторите через ${Math.ceil(seconds)} сек.`:'Повторите позже.'}`);return;}
      if(!response.ok) { setError('Не удалось войти. Проверьте email и пароль владельца.'); return; }
      window.location.href='/office';
    } catch { setError('Нет соединения с сервером. Повторите вход.'); } finally {setBusy(false);}
  }
  return <main className={styles.page}><div className={styles.card}>
    <div className={styles.brand}>orvo<span>●</span></div><p className={styles.eyebrow}>ВАШ ОФИС ИИ-АГЕНТОВ</p>
    <h1>С возвращением</h1><p className={styles.description}>Войдите в личное пространство, чтобы продолжить работу с командой.</p>
    <form onSubmit={submit}><label>Email владельца<input name="email" type="email" autoComplete="username" required/></label><label>Пароль<input name="password" type="password" autoComplete="current-password" required minLength={12}/></label>
    {error&&<p role="alert" className={styles.error}>{error}</p>}<button disabled={busy}>{busy?'Входим…':'Войти в офис →'}</button></form>
    <p className={styles.hint}>Закрытое пространство. Владелец создаётся командой <code>npm run owner:create</code>.</p>
  </div><div className={styles.scene} aria-hidden="true"><img src="/design/office.svg" alt=""/></div></main>;
}
