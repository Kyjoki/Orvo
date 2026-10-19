'use client';
import { useEffect, useState } from 'react';
import styles from './SecuritySettings.module.css';

type Status={required:boolean;enabled:boolean;verifiedSession:boolean;setupRequired:boolean;stepUpRequired:boolean};
async function send(path:string,body:Record<string,unknown>){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(response.status===429?'Слишком много попыток. Повторите позже.':value.error?.message||'Не удалось выполнить действие.');
  return value;
}
export default function SecuritySettings(){
  const [status,setStatus]=useState<Status|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [password,setPassword]=useState('');
  const [code,setCode]=useState('');
  const [uri,setUri]=useState('');
  const [qr,setQr]=useState('');
  useEffect(()=>{fetch('/api/security/status',{cache:'no-store'}).then(async response=>{
    if(response.status===401){location.assign('/login');return;}
    if(!response.ok)throw new Error('Не удалось загрузить настройки безопасности.');
    setStatus(await response.json());
  }).catch(error=>setError(error.message));},[]);
  async function action(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  async function refresh(){const response=await fetch('/api/security/status',{cache:'no-store'});if(!response.ok)throw new Error('Не удалось обновить состояние защиты.');setStatus(await response.json());}
  const enable=()=>action(async()=>{
    const value=await send('/api/auth/two-factor/enable',{password,method:'totp'});
    if(typeof value.totpURI!=='string')throw new Error('Сервер не вернул данные настройки.');
    setUri(value.totpURI);setPassword('');
    const QR=await import('qrcode');setQr(await QR.toDataURL(value.totpURI,{margin:1,width:220,errorCorrectionLevel:'M'}));
  });
  const verify=()=>action(async()=>{
    await send('/api/auth/two-factor/verify-totp',{code:code.trim(),trustDevice:false});
    setCode('');await refresh();
    location.assign('/office');
  });
  const disable=()=>action(async()=>{
    await send('/api/security/manage',{action:'disable',password,code:code.trim()});
    setPassword('');setCode('');
    setUri('');setQr('');await refresh();
  });
  const secret=uri?new URL(uri).searchParams.get('secret'):null;
  return <section className={styles.card} aria-label="Двухфакторная защита">
    <div className={styles.brand}>orvo<span>●</span></div>
    <h1>Безопасность входа</h1>
    <p className={styles.muted}>Для входа используйте пароль и код приложения аутентификации.</p>
    {!status&&!error&&<p>Загружаем состояние…</p>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}
    {status?.stepUpRequired&&<div className={styles.panel}>
      <h2>Подтвердите второй фактор</h2><p>Эта сессия ещё не подтверждена. Введите код приложения.</p>
      <label>Код приложения<input value={code} onChange={event=>setCode(event.target.value)} autoComplete="one-time-code" inputMode="numeric" maxLength={6}/></label>
      <button disabled={busy||!code.trim()} onClick={verify}>Подтвердить</button>
    </div>}
    {status&&!status.enabled&&!uri&&<div className={styles.panel}>
      <h2>Включить защиту</h2><p>Введите пароль владельца. Код для настройки появится только после этого действия.</p>
      <label>Текущий пароль<input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)}/></label>
      <button disabled={busy||!password} onClick={enable}>Начать настройку</button>
    </div>}
    {uri&&<div className={styles.panel}>
      <h2>Добавьте Orvo в аутентификатор</h2>
      {qr&&<img className={styles.qr} src={qr} alt="QR-код для настройки приложения аутентификации"/>}
      <p className={styles.muted}>Если сканирование недоступно, введите ключ вручную:</p><code className={styles.secret}>{secret}</code>
      <label>Код из приложения<input value={code} onChange={event=>setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6}/></label>
      {!status?.enabled&&<button disabled={busy||!/^\d{6}$/.test(code)} onClick={verify}>Подтвердить и включить</button>}
    </div>}
    {status?.enabled&&status.verifiedSession&&<div className={styles.panel}>
      <h2>Управление защитой</h2><p>Для отключения защиты нужны пароль и свежий код приложения.</p>
      <label>Текущий пароль<input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)}/></label>
      <label>Код приложения<input value={code} onChange={event=>setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6}/></label>
      <div className={styles.actions}><button className={styles.secondary} disabled={busy||!password||!/^\d{6}$/.test(code)} onClick={disable}>Отключить 2FA</button></div>
    </div>}
    <button className={styles.link} onClick={async()=>{await fetch('/api/auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});location.assign('/login');}}>Выйти</button>
  </section>;
}
