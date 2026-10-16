import {useEffect,useRef,useState,type CSSProperties} from "react";
import {Activity,ArrowRight,Check,CheckCircle2,Copy,FolderOpen,HardDrive,Info,LoaderCircle,LogIn,RefreshCw,ShieldCheck,TriangleAlert,Wifi} from "lucide-react";
import type {DiagnosticCheck,DiagnosticReport} from "../contracts/launcher";
import {ViewState} from "./ViewState";

export function diagnosticText(report:DiagnosticReport):string {
  return [`Mados Launcher · Диагностика подключения`,report.address,new Date(report.checkedAt).toLocaleString(),...report.checks.map(c=>`${c.title}: ${c.status}\n${c.message}`)].join('\n\n');
}
export function DiagnosticsView({initialAddress="",autoRun=false,onAutoRun,onStorage,onLogin}:{initialAddress?:string;autoRun?:boolean;onAutoRun?:()=>void;onStorage:()=>void;onLogin?:()=>void}) {
  const [address,setAddress]=useState(initialAddress),[report,setReport]=useState<DiagnosticReport|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[copied,setCopied]=useState(false);
  const generation=useRef(0),running=useRef(false),autoStarted=useRef(false);
  useEffect(()=>()=>{generation.current++;},[]);
  useEffect(()=>window.mados.onEvent(event=>{if(event.event==='auth.changed'){generation.current++;running.current=false;setBusy(false);setReport(null);setCopied(false);}}),[]);
  const run=async()=>{
    if(running.current||!address.trim())return;running.current=true;const request=++generation.current;setBusy(true);setError(null);setReport(null);setCopied(false);
    try{const next=await window.mados.invoke<DiagnosticReport>('diagnostics.run',{address:address.trim()});if(request===generation.current)setReport(next);}
    catch(e){if(request===generation.current)setError((e as Error).message);}
    finally{if(request===generation.current){running.current=false;setBusy(false);}}
  };
  useEffect(()=>{
    // Defer until after StrictMode's effect replay; one explicit request starts one probe.
    let cancelled=false;
    queueMicrotask(()=>{if(!cancelled&&autoRun&&!autoStarted.current){autoStarted.current=true;onAutoRun?.();void run();}});
    return()=>{cancelled=true};
  },[]);
  const act=async(check:DiagnosticCheck)=>{
    setError(null);try{
      if(check.action==='retry'){await run();return;}
      if(check.action==='storage'){onStorage();return;}
      if(check.action==='login'){onLogin?.();return;}
      if(check.action==='logs'){await window.mados.invoke('diagnostics.openLogs',{});return;}
      if(check.action==='connect'&&report){await window.mados.invoke('servers.connect',{address:report.address});}
    }catch(e){setError((e as Error).message);}
  };
  const failures=report?.checks.filter(c=>c.status==='failed').length??0;
  const warnings=report?.checks.filter(c=>c.status==='warning').length??0;
  const labels={retry:'Повторить проверку',connect:'Подключиться',storage:'Открыть хранилище',logs:'Открыть журналы',login:'Войти снова'};
  const icons={account:LogIn,server:Wifi,build:ShieldCheck,engine:FolderOpen,disk:HardDrive,download:RefreshCw};
  return <section className="maintenance-view diagnostics-view" aria-label="Диагностика подключения">
    <div className="maintenance-hero"><span className={`maintenance-emblem ${busy?'checking':''}`}><Activity size={30}/></span><div><span className="eyebrow">Понятно, что происходит</span><h2>Проверим подключение</h2><p>Сервер, сессия аккаунта, игровые файлы и свободное место — в одном отчёте.</p></div></div>
    <form className="diagnostic-form" onSubmit={e=>{e.preventDefault();void run();}}><label>Адрес сервера<div className="diagnostic-address"><Wifi size={17}/><input aria-label="Адрес для диагностики" value={address} onChange={e=>{generation.current++;running.current=false;setBusy(false);setReport(null);setCopied(false);setAddress(e.target.value);setError(null);}} placeholder="ss14://адрес:1212" spellCheck={false}/></div></label><button data-action="diagnose" className="primary-button" disabled={busy||!address.trim()}>{busy?<LoaderCircle className="spin" size={17}/>:<Activity size={17}/>} {busy?'Проверяем…':'Проверить подключение'}</button></form>
    {error&&<ViewState compact kind="error" title="Проверка не завершена" description={error} action="Повторить" onAction={()=>void run()}/>}
    {busy&&<ViewState kind="loading" icon={<LoaderCircle className="spin" size={26}/>} title="Получаем реальные ответы" description="Проверяем сервер и локальные файлы. При недоступной сети это может занять несколько секунд."/>}
    {!report&&!busy&&!error&&<div className="maintenance-empty"><ShieldCheck size={26}/><h3>Проверка по вашему запросу</h3><p>Введите адрес или откройте диагностику из ошибки запуска. Проверка не запускает игру и не меняет файлы.</p></div>}
    {report&&<><div className={`diagnostic-result-summary ${failures?'has-errors':''}`}><span>{failures?<TriangleAlert size={19}/>:<ShieldCheck size={19}/>}</span><div><strong>{failures?`Найдены проблемы: ${failures}`:warnings?'Есть рекомендации':'Проверки завершены'}</strong><p>{new Date(report.checkedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})} · {report.address}</p></div><button className="secondary-button compact-button" data-action="copy-diagnostics" onClick={()=>void navigator.clipboard.writeText(diagnosticText(report)).then(()=>setCopied(true)).catch(()=>setError('Не удалось скопировать отчёт. Попробуйте ещё раз.'))}>{copied?<Check size={15}/>:<Copy size={15}/>} {copied?'Скопировано':'Копировать отчёт'}</button></div>
      <div className="diagnostic-checks">{report.checks.map((check,index)=>{const Icon=icons[check.id as keyof typeof icons]??Info;return <article key={report.checkedAt+check.id} className={`diagnostic-check ${check.status}`} style={{'--item-index':index} as CSSProperties}><span className="diagnostic-check-icon"><Icon size={21}/></span><div><h3>{check.title}</h3><p>{check.message}</p>{check.action&&(check.action!=='login'||onLogin)&&<button className="text-link" onClick={()=>void act(check)}>{labels[check.action]}<ArrowRight size={14}/></button>}</div><span className="diagnostic-check-status" aria-label={check.status==='passed'?'Пройдено':check.status==='failed'?'Ошибка':check.status==='warning'?'Внимание':'Информация'}>{check.status==='passed'?<CheckCircle2 size={18}/>:check.status==='failed'||check.status==='warning'?<TriangleAlert size={18}/>:<Info size={18}/>}</span></article>;})}</div>
      <p className="maintenance-footnote">Отчёт содержит результаты проверок, без паролей и токенов. Доступ к игровому серверу и полная проверка файлов выполняются при подключении.</p></>}
  </section>;
}
