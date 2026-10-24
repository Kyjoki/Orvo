'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Archive, Building2, Check, ChevronDown, Plus, RotateCcw, Trash2 } from 'lucide-react';
import styles from './OfficeSwitcher.module.css';

type Office={id:string;name:string;officeDesign:'classic'|'studio'};

export default function OfficeSwitcher({offices,archivedOffices=[],activeOfficeId,activeOfficeName}:{offices:Office[];archivedOffices?:Office[];activeOfficeId:string;activeOfficeName:string}){
  const[dialog,setDialog]=useState<'create'|'rename'|'archive'|'purge'|null>(null);
  const[name,setName]=useState('');
  const[deleteTarget,setDeleteTarget]=useState<Office|null>(null);
  const[error,setError]=useState('');
  const[busy,setBusy]=useState(false);
  const[menuOpen,setMenuOpen]=useState(false);
  const rootRef=useRef<HTMLDivElement>(null);
  const triggerRef=useRef<HTMLButtonElement>(null);
  const officeRefs=useRef<Array<HTMLButtonElement|null>>([]);
  const currentOfficeIndex=Math.max(0,offices.findIndex(office=>office.id===activeOfficeId));

  useEffect(()=>{
    if(!menuOpen)return;
    officeRefs.current[currentOfficeIndex]?.focus();
    const closeOutside=(event:PointerEvent)=>{
      if(!rootRef.current?.contains(event.target as Node))setMenuOpen(false);
    };
    document.addEventListener('pointerdown',closeOutside);
    return()=>document.removeEventListener('pointerdown',closeOutside);
  },[menuOpen,currentOfficeIndex]);

  const openDialog=(mode:'create'|'rename'|'archive')=>{setError('');setDeleteTarget(null);setName(mode==='rename'?activeOfficeName:'');setDialog(mode);};
  const openPurgeDialog=(office:Office)=>{setError('');setName('');setDeleteTarget(office);setDialog('purge');};
  const submit=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();setBusy(true);setError('');
    try{
      const deleting=dialog==='archive'||dialog==='purge';
      const response=await fetch('/api/offices',{method:deleting?'DELETE':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(deleting?{action:dialog==='purge'?'purge':'archive',workspaceId:dialog==='purge'?deleteTarget?.id:activeOfficeId,confirmName:name}:{action:dialog,name})});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error?.message||'Не удалось сохранить офис.');
      window.location.assign('/office');
    }catch(cause){setError((cause as Error).message);setBusy(false);}
  };
  const switchOffice=async(id:string)=>{
    if(id===activeOfficeId)return;
    setMenuOpen(false);
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/offices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'switch',workspaceId:id})});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error?.message||'Не удалось открыть офис.');
      window.location.assign('/office');
    }catch(cause){setError((cause as Error).message);setBusy(false);}
  };
  const restoreOffice=async(id:string)=>{
    setBusy(true);setError('');setMenuOpen(false);
    try{
      const response=await fetch('/api/offices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'restore',workspaceId:id})});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error?.message||'Не удалось восстановить офис.');
      window.location.assign('/office');
    }catch(cause){setError((cause as Error).message);setBusy(false);}
  };

  const handleMenuKeyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
    const officeCount=offices.length+(!offices.some(office=>office.id===activeOfficeId)?1:0);
    const focusedIndex=officeRefs.current.findIndex(item=>item===document.activeElement);
    let nextIndex:number|undefined;
    if(event.key==='ArrowDown')nextIndex=(focusedIndex+1+officeCount)%officeCount;
    else if(event.key==='ArrowUp')nextIndex=(focusedIndex-1+officeCount)%officeCount;
    else if(event.key==='Home')nextIndex=0;
    else if(event.key==='End')nextIndex=officeCount-1;
    else if(event.key==='Escape'){
      event.preventDefault();setMenuOpen(false);triggerRef.current?.focus();return;
    }else if(event.key==='Tab'){
      setMenuOpen(false);return;
    }
    if(nextIndex!==undefined){event.preventDefault();officeRefs.current[nextIndex]?.focus();}
  };

  return <div className={styles.root}>
    <span className={styles.label} id="office-switcher-label">Текущий офис</span>
    <div className={styles.controls} ref={rootRef}>
      <button ref={triggerRef} type="button" className={styles.switcher} onClick={()=>setMenuOpen(value=>!value)} disabled={busy} aria-labelledby="office-switcher-label office-switcher-value" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls="office-menu">
        <span className={styles.officeMark} aria-hidden="true"><Building2 size={15}/></span>
        <span id="office-switcher-value" className={styles.currentName}>{activeOfficeName}</span>
        <ChevronDown className={styles.chevron+(menuOpen?' '+styles.chevronOpen:'')} size={15} aria-hidden="true"/>
      </button>
      <button type="button" className={styles.add} onClick={()=>openDialog('create')} title="Создать офис" aria-label="Создать офис" disabled={busy}><Plus size={17}/></button>
      {menuOpen&&<div id="office-menu" className={styles.menu} role="menu" aria-label="Офисы" onKeyDown={handleMenuKeyDown}>
        <span className={styles.menuCaption}>ПРОСТРАНСТВА</span>
        {offices.map((office,index)=><button ref={element=>{officeRefs.current[index]=element;}} key={office.id} type="button" role="menuitemradio" aria-checked={office.id===activeOfficeId} className={office.id===activeOfficeId?styles.option+' '+styles.optionActive:styles.option} onClick={()=>{setMenuOpen(false);void switchOffice(office.id);}} disabled={busy}>
          <span className={styles.optionMark} aria-hidden="true"><Building2 size={15}/></span>
          <span className={styles.optionName}>{office.name}</span>
          {office.id===activeOfficeId?<Check size={15} className={styles.check} aria-hidden="true"/>:<span className={styles.optionSpacer}/>}
        </button>)}
        {!offices.some(office=>office.id===activeOfficeId)&&<button ref={element=>{officeRefs.current[offices.length]=element;}} type="button" role="menuitemradio" aria-checked="true" className={styles.option+' '+styles.optionActive} onClick={()=>{setMenuOpen(false);void switchOffice(activeOfficeId);}}>
          <span className={styles.optionMark} aria-hidden="true"><Building2 size={15}/></span><span className={styles.optionName}>{activeOfficeName}</span><Check size={15} className={styles.check} aria-hidden="true"/>
        </button>}
        {archivedOffices.length>0&&<div className={styles.archiveList}>
          <span className={styles.menuCaption}>АРХИВ · МОЖНО ВОССТАНОВИТЬ</span>
          {archivedOffices.map(office=><div className={styles.archivedOffice} key={office.id}><span className={styles.archivedOfficeName} title={office.name}>{office.name}</span><button type="button" className={styles.restoreButton} onClick={()=>void restoreOffice(office.id)} disabled={busy} aria-label={`Восстановить офис ${office.name}`} title="Восстановить офис"><RotateCcw size={14}/></button><button type="button" className={styles.trashButton} onClick={()=>openPurgeDialog(office)} disabled={busy} aria-label={`Удалить офис ${office.name} навсегда`} title="Удалить навсегда"><Trash2 size={14}/></button></div>)}
        </div>}
        <div className={styles.menuFooter}>Каждый офис хранит свои задачи и команду</div>
      </div>}
    </div>
    <button type="button" className={styles.rename} onClick={()=>openDialog('rename')} disabled={busy}>Переименовать офис</button>
    {offices.length>1&&offices[0]?.id!==activeOfficeId&&<button type="button" className={styles.archiveButton} onClick={()=>openDialog('archive')} disabled={busy}><Archive size={13}/>Убрать офис в архив</button>}
    {error&&<p className={styles.error} role="alert">{error}</p>}
    {dialog&&<div className={styles.backdrop} onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)setDialog(null);}} onKeyDown={event=>{if(event.key==='Escape'&&!busy)setDialog(null);}}>
      <form className={styles.dialog} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="office-dialog-title" aria-describedby="office-dialog-description">
        <h2 id="office-dialog-title">{dialog==='create'?'Новый офис':dialog==='purge'?'Удалить офис навсегда?':dialog==='archive'?'Убрать офис в архив?':'Переименовать офис'}</h2>
        <p id="office-dialog-description">{dialog==='create'?'Для стартапа создастся отдельный офис с пустыми агентами, задачами и памятью.':dialog==='purge'?<>Офис «{deleteTarget?.name}» и все его данные — агенты, задачи, память, история, настройки и подключения — будут удалены без возможности восстановления. Для подтверждения введите название офиса полностью.</>:dialog==='archive'?<>«{activeOfficeName}» исчезнет из обычного списка. Агенты, задачи, память и настройки сохранятся; офис можно восстановить через меню офисов. Чтобы подтвердить, введите название полностью.</>:'Название появится в переключателе и на вывеске офиса.'}</p>
        <label htmlFor="office-name">{dialog==='archive'||dialog==='purge'?'Точное название офиса':'Название'}</label>
        <input id="office-name" value={name} onChange={event=>setName(event.target.value)} placeholder={dialog==='purge'?deleteTarget?.name:dialog==='archive'?activeOfficeName:undefined} maxLength={60} required autoFocus />
        {error&&<p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <button type="button" onClick={()=>setDialog(null)} disabled={busy}>Отмена</button>
          <button type="submit" className={dialog==='purge'?styles.dangerAction:undefined} disabled={busy||!name.trim()||((dialog==='archive'||dialog==='purge')&&name!==(dialog==='purge'?deleteTarget?.name:activeOfficeName))}>{busy?(dialog==='archive'?'Перемещаю…':dialog==='purge'?'Удаляю…':'Сохраняю…'):dialog==='create'?'Создать офис':dialog==='archive'?'В архив':dialog==='purge'?'Удалить навсегда':'Сохранить'}</button>
        </div>
      </form>
    </div>}
  </div>;
}
