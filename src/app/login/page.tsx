'use client';
import { useState } from 'react';
import styles from './login.module.css';
export default function Login() {
  const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  const [challenge,setChallenge]=useState(false); const [code,setCode]=useState('');
  async function destination(){
    const response=await fetch('/api/security/status',{cache:'no-store'});
    if(!response.ok)throw new Error('Не удалось проверить состояние защиты входа.');
    const status=await response.json();
    window.location.href=status.setupRequired||status.stepUpRequired?'/security':'/office';
  }
  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form=new FormData(event.currentTarget);
    try {
      const response=await fetch('/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.get('email'),password:form.get('password')})});
      if(response.status===429){const seconds=Number(response.headers.get('Retry-After')||response.headers.get('X-Retry-After'));setError(`Слишком много попыток входа. ${seconds>0?`Повторите через ${Math.ceil(seconds)} сек.`:'Повторите позже.'}`);return;}
      if(!response.ok) { setError('Не удалось войти. Проверьте email и пароль владельца.'); return; }
      const result=await response.json();
      if(result.twoFactorRedirect){setChallenge(true);setCode('');return;}
      await destination();
    } catch { setError('Не удалось завершить вход. Проверьте соединение и повторите.'); } finally {setBusy(false);}
  }
  async function verify(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setError('');
    try{
      const response=await fetch('/api/auth/two-factor/verify-totp',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code.trim(),trustDevice:false}),
      });
      if(response.status===429){setError('Слишком много попыток. Повторите позже.');return;}
      if(!response.ok){setError('Код не принят. Проверьте значение в приложении.');return;}
      await destination();
    }catch{setError('Не удалось завершить проверку. Повторите попытку.');}finally{setBusy(false);}
  }
  return <main className={styles.page}><div className={styles.card}>
    <div className={styles.brand}>orvo<span>●</span></div><p className={styles.eyebrow}>ВАШ ОФИС ИИ-АГЕНТОВ</p>
    <h1>{challenge?'Подтвердите вход':'С возвращением'}</h1><p className={styles.description}>{challenge?'Введите код приложения аутентификации.':'Войдите в личное пространство, чтобы продолжить работу с командой.'}</p>
    {!challenge?<form onSubmit={submit}><label>Email владельца<input name="email" type="email" autoComplete="username" required/></label><label>Пароль<input name="password" type="password" autoComplete="current-password" required minLength={12}/></label>
    {error&&<p role="alert" className={styles.error}>{error}</p>}<button disabled={busy}>{busy?'Входим…':'Войти в офис →'}</button></form>
    :<form onSubmit={verify}><label>Код приложения<input value={code} onChange={event=>setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} required/></label>
    {error&&<p role="alert" className={styles.error}>{error}</p>}<button disabled={busy||!code.trim()}>{busy?'Проверяем…':'Подтвердить вход →'}</button></form>}
    <p className={styles.hint}>Доступ разрешён только владельцу рабочего пространства.</p>
  </div><div className={styles.scene} aria-hidden="true"><img src="/design/office.svg" alt=""/></div></main>;
}
