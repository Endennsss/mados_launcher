import { useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Pause, Play, Save, Terminal, Trash2 } from "lucide-react";
import type { LocalServerLogLine } from "../contracts/launcher";
import { ViewState } from "./ViewState";

export const isServerLogError=(line:LocalServerLogLine)=>line.stream==="stderr"||/\b(ERROR|ERRO|FATAL|FTL)\b/i.test(line.line);
type Props={profileId:string|null;name:string|null;lines:LocalServerLogLine[];onSave:()=>Promise<unknown>;onClear:()=>void};
export function LocalServerLogs(props:Props){return <LogPanel key={props.profileId} {...props}/>;}
function LogPanel({profileId,name,lines,onSave,onClear}:Props){
  const [open,setOpen]=useState(false),[follow,setFollow]=useState(true),[filter,setFilter]=useState<"all"|"errors">("all"),[saving,setSaving]=useState(false),[error,setError]=useState<string|null>(null);
  const view=useRef<HTMLDivElement>(null),alive=useRef(true),saveLock=useRef(false);
  useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const ownLines=lines.filter(line=>line.profileId===profileId),errors=ownLines.filter(isServerLogError),visible=filter==="errors"?errors:ownLines;
  useLayoutEffect(()=>{if(open&&follow&&view.current)view.current.scrollTop=view.current.scrollHeight;},[lines,open,follow,filter]);
  const save=async()=>{if(saveLock.current)return;saveLock.current=true;setSaving(true);setError(null);try{await onSave();}catch(caught){if(alive.current)setError(caught instanceof Error?caught.message:"Не удалось сохранить лог");}finally{saveLock.current=false;if(alive.current)setSaving(false);}};
  return <section className={`tool-card server-log-panel ${open?"logs-open":""}`} aria-label="Логи локального сервера"><button className="server-log-toggle" data-action="toggle-server-logs" aria-expanded={open} aria-controls="server-live-logs" onClick={()=>setOpen(!open)}><span className="tool-card-icon"><Terminal size={19} key={ownLines.at(-1)?.timestamp+":"+ownLines.length} className={open&&follow&&ownLines.length?"log-arrived":""}/></span><span><strong>Логи сервера</strong><small>{name??"Выберите локальный сервер"} · {ownLines.length} сообщений</small></span>{errors.length>0&&<span className="log-error-count"><AlertTriangle size={13}/>{errors.length}</span>}<ChevronDown size={18} className={open?"expanded":""}/></button>
    {open&&<div className="server-log-body" id="server-live-logs"><div className="server-log-controls"><div role="group" aria-label="Фильтр сообщений"><button data-log-filter="all" aria-pressed={filter==="all"} onClick={()=>setFilter("all")}>Все</button><button data-log-filter="errors" aria-pressed={filter==="errors"} onClick={()=>setFilter("errors")}>Ошибки {errors.length>0?errors.length:""}</button></div><div><button className="secondary-button compact-button" aria-label={follow?"Приостановить автопрокрутку":"Включить автопрокрутку"} aria-pressed={follow} onClick={()=>setFollow(!follow)}>{follow?<Pause size={13}/>:<Play size={13}/>}<span>{follow?"Автопрокрутка":"На паузе"}</span></button><button className="icon-button" disabled={saving||!ownLines.length} onClick={()=>void save()} aria-label="Сохранить лог"><Save size={15}/></button><button className="icon-button" disabled={!ownLines.length} onClick={onClear} aria-label="Очистить логи"><Trash2 size={15}/></button></div></div>
      {error&&<ViewState compact kind="error" title="Лог не сохранён" description={error} action="Повторить" onAction={()=>void save()}/>}
      <div className="tool-log-view" ref={view} role="log" aria-live="off" tabIndex={0} aria-label="Сообщения локального сервера" onScroll={()=>{const node=view.current;if(node&&follow&&node.scrollHeight-node.clientHeight-node.scrollTop>40)setFollow(false);}}>{visible.length?visible.map((line,index)=><div className={`tool-log-line ${isServerLogError(line)?"log-error":""}`} key={`${line.timestamp}-${index}`}><time>{new Date(line.timestamp).toLocaleTimeString()}</time><span>{line.line}</span></div>):<div className="tool-log-empty"><Terminal size={23}/><strong>{filter==="errors"?"Ошибок в журнале нет":"Пока нет сообщений"}</strong><span>{filter==="errors"?"Обычные сообщения доступны во вкладке «Все».":"Новые строки появятся после запуска сервера."}</span></div>}</div>
      <footer className="server-log-foot"><span>{follow?"Показываем новые сообщения":"Прокрутка на паузе · сообщения продолжают поступать"}</span><span>Последние 250 строк</span></footer>
    </div>}
  </section>;
}
