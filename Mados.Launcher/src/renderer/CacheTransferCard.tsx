import {useEffect,useRef,useState} from 'react';
import {ArrowRight,FolderOpen,HardDrive,LoaderCircle,RotateCw,ShieldCheck,Square} from 'lucide-react';
import type {CacheInfo,CacheTransferState} from '../contracts/launcher';
import {cacheInfoSchema,cacheTransferStateSchema} from '../contracts/schema';
import {useConfirm} from './ConfirmDialog';
import {formatBuildSize} from './tools-ui';

export function CacheTransferCard(){
 const [info,setInfo]=useState<CacheInfo|null>(null),[state,setState]=useState<CacheTransferState|null>(null),[folder,setFolder]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const alive=useRef(true),locked=useRef(false);const confirm=useConfirm();
 useEffect(()=>{alive.current=true;let updated=false;void window.mados.invoke<CacheInfo>('cache.info',{}).then(raw=>{const value=cacheInfoSchema.parse(raw);if(alive.current){setInfo(value);if(!updated)setState(value.state);}}).catch(e=>{if(alive.current)setError(e.message)});const off=window.mados.onEvent(e=>{if(e.event==='cache.progress'){updated=true;setState(e.data as CacheTransferState);}});return()=>{alive.current=false;off();}},[]);
 const run=async(action:()=>Promise<void>)=>{if(locked.current)return;locked.current=true;setBusy(true);setError(null);try{await action()}catch(e){if(alive.current)setError((e as Error).message)}finally{locked.current=false;if(alive.current)setBusy(false)}};
 const moving=state?.stage==='copying'||state?.stage==='verifying',ready=state?.stage==='ready';
 const move=async()=>{if(!folder)return;const chosen=folder;if(!await confirm({title:'Перенести игровой кэш?',message:`Новая папка будет создана внутри ${chosen}. Завершите игру. Файлы проверятся после копирования, исходная копия удалится только после успешного перезапуска.`,confirmLabel:'Перенести'}))return;if(!alive.current)return;await run(async()=>{const result=await window.mados.invoke<CacheTransferState>('cache.move',{folder:chosen});if(alive.current){setState(result);setFolder(null);}})};
 return <section className="toolkit-card cache-transfer" aria-label="Перенос игрового кэша"><header><span className="toolkit-icon"><HardDrive size={23}/></span><div><h3>Игры на другом диске</h3><p>Перенесите скачанные сборки без повторной загрузки.</p></div></header>
  <div className="toolkit-paths"><span>Сейчас</span><code>{info?.paths.localPath??'Читаем расположение…'}</code>{info&&info.paths.userPath!==info.paths.localPath&&<code>{info.paths.userPath}</code>}{folder&&<><span>Новая папка</span><code>{folder}</code></>}</div>
  {error&&<p className="toolkit-error" role="alert">{error}</p>}{info?.warnings.map(w=><p className="maintenance-notice" key={w}>{w}</p>)}
  {(moving||ready||state?.message)&&<div className="toolkit-progress" role="status"><strong>{ready?'Кэш перенесён и проверен':moving?(state.stage==='verifying'?'Проверяем файлы':'Копируем файлы'):state?.message}</strong>{moving&&<><progress max={Math.max(1,state.totalBytes)} value={state.completedBytes}/><span>{formatBuildSize(state.completedBytes)} / {formatBuildSize(state.totalBytes)}</span></>}{ready&&<p>Перезапустите Mados, чтобы использовать новое расположение. До этого запуск игры временно заблокирован.</p>}</div>}
  <footer className="toolkit-actions">{ready?<button className="primary-button" disabled={busy} onClick={()=>void run(async()=>{await window.mados.invoke('app.restart',{})})}><RotateCw size={17}/>Перезапустить Mados</button>:moving?<button className="secondary-button" onClick={()=>void window.mados.invoke('cache.cancel',{}).catch(e=>setError(e.message))}><Square size={16}/>Отменить перенос</button>:<><button className="secondary-button" data-action="choose-cache" disabled={busy} onClick={()=>void run(async()=>{const result=await window.mados.invoke<string|null>('cache.chooseFolder',{});if(alive.current)setFolder(result)})}><FolderOpen size={17}/>Выбрать папку</button><button className="primary-button" data-action="move-cache" disabled={!folder||busy} onClick={()=>void move()}>{busy?<LoaderCircle className="spin" size={17}/>:<ArrowRight size={17}/>}Перенести</button></>}</footer>
  <p className="toolkit-footnote"><ShieldCheck size={14}/>Аккаунты, реплеи и локальные серверы остаются на своих местах.</p>
 </section>;
}

export function CacheTransferNotice(){
 const [state,setState]=useState<CacheTransferState|null>(null),[error,setError]=useState<string|null>(null);
 useEffect(()=>{let current=true,updated=false;void window.mados.invoke<CacheInfo>('cache.info',{}).then(raw=>{const result=cacheInfoSchema.safeParse(raw);if(current&&!updated&&result.success)setState(result.data.state)}).catch(()=>{ /* The storage screen owns read-error feedback. */ });const off=window.mados.onEvent(e=>{if(e.event==='cache.progress'){const next=cacheTransferStateSchema.safeParse(e.data);if(next.success){updated=true;setState(next.data)}}});return()=>{current=false;off()}},[]);
 if(!state||!['ready','copying','verifying'].includes(state.stage))return null;
 const ready=state.stage==='ready';
 return <aside className="seat-watch compact" aria-label="Состояние переноса кэша"><span className="toolkit-icon">{ready?<ShieldCheck size={18}/>:<LoaderCircle size={18} className="spin"/>}</span><div><strong>{ready?'Кэш перенесён — перезапустите Mados':'Перенос игрового кэша'}</strong><p>{ready?'Новое расположение начнёт использоваться после перезапуска.':`${formatBuildSize(state.completedBytes)} / ${formatBuildSize(state.totalBytes)} · запуск игры временно недоступен`}</p>{error&&<p className="toolkit-error" role="alert">{error}</p>}</div>{ready&&<button className="secondary-button" onClick={()=>void window.mados.invoke('app.restart',{}).catch(e=>setError(e.message))}><RotateCw size={16}/>Перезапустить</button>}</aside>;
}
