import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bell, BellOff, Check, CheckCheck, Download, RefreshCw, Trash2, Wifi, X } from "lucide-react";
import type { LauncherNotification, ShellUpdateState } from "../contracts/launcher";
import { launcherNotificationSchema } from "../contracts/schema";
import { useConfirm } from "./ConfirmDialog";
import { formatDurationSince } from "./monitoring";

const ordered = (items: LauncherNotification[]) => [...items].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,100);
export function useNotifications(accountId?: string) {
  const [data,setData] = useState<{accountId?:string; items:LauncherNotification[]}>({items:[]});
  const [toast,setToast] = useState<LauncherNotification|null>(null), [error,setError] = useState<string|null>(null);
  const [loading,setLoading] = useState(false), [busy,setBusy] = useState(false);
  const account = useRef(accountId); account.current = accountId;
  const lifetime = useRef(0), request = useRef(0), pending = useRef(false);
  const overrides = useRef(new Map<string,LauncherNotification>());
  const items = data.accountId===accountId ? data.items : [];
  const refresh = useCallback(async () => {
    if (!accountId) return;
    const epoch = lifetime.current, seq = ++request.current;
    const current = () => account.current===accountId && lifetime.current===epoch && request.current===seq;
    setLoading(true); setError(null);
    try {
      const list = (await window.mados.notifications.list()).map(item=>launcherNotificationSchema.parse(item));
      if (!current()) return;
      const merged = new Map(list.filter(item=>!item.accountId || item.accountId===accountId).map(item=>[item.id,item]));
      overrides.current.forEach((item,id)=>merged.set(id,item));
      setData({accountId,items:ordered([...merged.values()])});
    } catch(caught) { if(current()) setError((caught as Error).message); }
    finally { if(current()) setLoading(false); }
  },[accountId]);
  useEffect(()=>{
    ++lifetime.current; overrides.current.clear(); pending.current=false;
    setData({accountId,items:[]});setToast(null);setBusy(false);setError(null);setLoading(false);
    if(!accountId)return;
    void refresh();
    const epoch=lifetime.current;
    const unsubscribe=window.mados.onEvent(event=>{
      if(event.event!=="notification.created" || lifetime.current!==epoch || account.current!==accountId)return;
      const parsed=launcherNotificationSchema.safeParse(event.data);
      if(!parsed.success){setError("Не удалось прочитать новое уведомление. Обновите журнал.");return;}
      const item=parsed.data;
      if(!item?.id || (item.accountId && item.accountId!==accountId))return;
      overrides.current.set(item.id,item);
      setData(current=>({accountId,items:ordered([item,...(current.accountId===accountId ? current.items : []).filter(other=>other.id!==item.id)])}));
      setToast(item);
    });
    return()=>{++lifetime.current;unsubscribe();};
  },[accountId,refresh]);
  useEffect(()=>{if(!toast)return;const timer=window.setTimeout(()=>setToast(null),5200);return()=>clearTimeout(timer);},[toast]);
  const mutate = async (action: ()=>Promise<void>) => {
    if(!accountId || pending.current)return false;
    const epoch=lifetime.current;pending.current=true;setBusy(true);setError(null);
    try {await action();return account.current===accountId && lifetime.current===epoch;}
    catch(caught){if(account.current===accountId && lifetime.current===epoch)setError((caught as Error).message);return false;}
    finally{if(account.current===accountId && lifetime.current===epoch){pending.current=false;setBusy(false);}}
  };
  const read = async (item:LauncherNotification) => {
    if(item.readAt)return true;
    const epoch=lifetime.current;
    return mutate(async()=>{
      const result=await window.mados.notifications.markRead(item.id);
      if(!result.marked)throw Error("Событие больше недоступно. Обновите журнал.");
      if(account.current!==accountId || lifetime.current!==epoch)return;
      const next={...item,readAt:new Date().toISOString()};overrides.current.set(item.id,next);
      setData(current=>({...current,items:current.items.map(other=>other.id===item.id?next:other)}));
    });
  };
  const clear = async () => {
    const epoch=lifetime.current;
    return mutate(async()=>{
      await window.mados.notifications.clear();
      if(account.current!==accountId || lifetime.current!==epoch)return;
      overrides.current.clear();setToast(null);await refresh();
    });
  };
  return {items,toast:data.accountId===accountId ? toast : null,dismissToast:()=>setToast(null),error,loading,busy,refresh,read,clear};
}

export function NotificationCenter({accountId,items,loading,busy,error,refresh,read,clear,onClose,onAction,update}: {
  accountId:string; items:LauncherNotification[];loading:boolean;busy:boolean;error:string|null;
  refresh:()=>Promise<void>;read:(item:LauncherNotification)=>Promise<boolean>;clear:()=>Promise<boolean>;
  onClose:()=>void;onAction:(item:LauncherNotification)=>void;update?:ShellUpdateState;
}) {
  const confirm=useConfirm(accountId);
  const [filter,setFilter]=useState<"all"|"unread">("all");
  const closeButton=useRef<HTMLButtonElement>(null), panel=useRef<HTMLElement>(null);
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;closeButton.current?.focus({preventScroll:true});
    const outside=(event:Event)=>{if(!panel.current?.contains(event.target as Node) && !(event.target as HTMLElement).closest?.('.notification-trigger,.mados-dialog-overlay'))close.current();};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close.current();}};
    window.addEventListener('pointerdown',outside);window.addEventListener('keydown',escape);
    return()=>{window.removeEventListener('pointerdown',outside);window.removeEventListener('keydown',escape);if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[]);
  const unread=items.filter(item=>!item.readAt).length;
  const filtered=ordered(items.filter(item=>filter==='all'||!item.readAt));
  const today=new Date().toDateString();
  const groups=[{label:'Сегодня',items:filtered.filter(item=>new Date(item.createdAt).toDateString()===today)},{label:'Ранее',items:filtered.filter(item=>new Date(item.createdAt).toDateString()!==today)}];
  const clearHistory=async()=>{if(await confirm({title:'Очистить уведомления?',message:'События этого аккаунта будут удалены из журнала.',confirmLabel:'Очистить',destructive:true}))await clear();};
  const markRead=async(item:LauncherNotification)=>{closeButton.current?.focus({preventScroll:true});await read(item);};
  const availableUpdate=update?.version && ['available','downloading','downloaded'].includes(update.status);
  return <aside ref={panel} className="activity-center" role="dialog" aria-label="Центр уведомлений">
    <header className="activity-center-heading"><div className="activity-center-brand"><span><Bell size={21}/></span><div><p className="eyebrow">События Mados</p><h2>Уведомления</h2></div></div><button ref={closeButton} className="icon-button" aria-label="Закрыть уведомления" onClick={onClose}><X size={18}/></button></header>
    <div className="activity-center-toolbar"><div className="activity-periods" role="group" aria-label="Фильтр уведомлений"><button data-filter="all" aria-pressed={filter==='all'} className={filter==='all'?'selected':''} onClick={()=>setFilter('all')}>Все <span>{items.length}</span></button><button data-filter="unread" aria-pressed={filter==='unread'} className={filter==='unread'?'selected':''} onClick={()=>setFilter('unread')}>Непрочитанные <span>{unread}</span></button></div><button className="icon-button" aria-label="Обновить уведомления" disabled={loading||busy} onClick={()=>void refresh()}><RefreshCw size={16} className={loading?'refresh-once':''}/></button></div>
    {error && <div className="activity-feedback" role="alert"><span>{error}</span><button className="ghost-button" onClick={()=>void refresh()} disabled={busy||loading}>Повторить</button></div>}
    <div className="activity-center-scroll">
      {availableUpdate && <div className="notification-update-card"><Download size={22}/><div><strong>Mados {update.version}</strong><p>{update.status==='downloaded'?'Обновление готово к установке':update.status==='downloading'?'Скачиваем обновление':'Доступна новая версия'}</p><button className="ghost-button" onClick={()=>onAction({id:'current-update',kind:'launcher-update',title:'Обновление Mados',message:'',createdAt:new Date().toISOString(),readAt:null})}>Посмотреть обновление <ArrowRight size={14}/></button></div></div>}
      {loading && !items.length ? <div className="activity-empty" role="status"><Bell size={26}/><p>Загружаем события…</p></div> : !filtered.length ? <div className="activity-empty"><BellOff size={30}/><h3>{filter==='unread'?'Всё прочитано':'Здесь пока тихо'}</h3><p>{filter==='unread'?'Новые события появятся здесь.':'Сообщим об обновлениях и возвращении избранных серверов.'}</p></div> : groups.filter(group=>group.items.length).map(group=><section className="notification-group" key={group.label}><h3>{group.label}<span>{group.items.length}</span></h3>{group.items.map(item=><article key={item.id} data-notification={item.id} className={`activity-notification ${item.readAt?'read':'unread'}`}><span className={`activity-notification-icon ${(item.kind==='favorite-online'||item.kind==='server-slot')?'success':''}`}>{(item.kind==='favorite-online'||item.kind==='server-slot')?<Wifi size={18}/>:<Download size={18}/>}</span><div className="activity-notification-copy"><div className="activity-notification-title"><h4>{item.title}</h4>{!item.readAt&&<i aria-label="Не прочитано"/>}</div><p>{item.message}</p><time dateTime={item.createdAt} data-tooltip={new Date(item.createdAt).toLocaleString('ru-RU')}>{formatDurationSince(item.createdAt)}</time><div className="activity-notification-actions"><button className="ghost-button" data-action="open-notification" onClick={()=>onAction(item)}>{item.kind==='launcher-update'?'Посмотреть обновление':(item.kind==='favorite-online'||item.kind==='server-slot')&&item.address?'Открыть сервер':'Открыть каталог'}<ArrowRight size={14}/></button>{!item.readAt?<button className="icon-button" data-action="read-notification" aria-label="Отметить прочитанным" data-tooltip="Прочитано" disabled={busy} onClick={()=>void markRead(item)}><CheckCheck size={16}/></button>:<Check size={14} className="notification-read-check" aria-label="Прочитано"/>}</div></div></article>)}</section>)}
    </div><footer className="activity-center-footer"><span>Журнал на этом устройстве</span><button className="ghost-button" disabled={busy||loading||!items.length} onClick={()=>void clearHistory()}><Trash2 size={14}/>Очистить</button></footer>
  </aside>;
}
