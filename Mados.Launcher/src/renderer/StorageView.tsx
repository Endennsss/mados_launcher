import {useCallback,useEffect,useRef,useState,type CSSProperties} from "react";
import {ArrowRight,CheckCircle2,Database,FileText,HardDrive,Layers,LoaderCircle,LockKeyhole,RefreshCw,ServerCog,ShieldCheck,Trash2} from "lucide-react";
import type {StorageCleanResult,StoragePreview,StorageScan} from "../contracts/launcher";
import {useConfirm} from "./ConfirmDialog";
import {CacheTransferCard} from "./CacheTransferCard";
import {ViewState} from "./ViewState";

export function storageSize(bytes:number):string {if(bytes<1024)return `${bytes} Б`;const units=['КБ','МБ','ГБ','ТБ'];let value=bytes/1024,index=0;while(value>=1024&&index<units.length-1){value/=1024;index++;}return `${new Intl.NumberFormat('ru',{maximumFractionDigits:1}).format(value)} ${units[index]}`;}
export function StorageView(){
 const [scan,setScan]=useState<StorageScan|null>(null),[selected,setSelected]=useState<string[]>([]),[preview,setPreview]=useState<StoragePreview|null>(null),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[result,setResult]=useState<StorageCleanResult|null>(null),[liveBusy,setLiveBusy]=useState(false);
 const alive=useRef(true),working=useRef(false);const confirm=useConfirm();
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 useEffect(()=>window.mados.onEvent(event=>{
  if(event.event==='connection.started'){setLiveBusy(true);setPreview(null);}
  if(event.event==='connection.completed'||event.event==='connection.failed')setLiveBusy(false);
  if(event.event==='localServer.status'){const s=(event.data as {status:string}).status;setLiveBusy(['starting','running','stopping'].includes(s));setPreview(null);}
 }),[]);
 const load=useCallback(async()=>{
  if(working.current)return;working.current=true;setBusy('scan');setError(null);setPreview(null);
  try{const next=await window.mados.invoke<StorageScan>('storage.scan',{});if(alive.current){setScan(next);setSelected(ids=>ids.filter(id=>next.items.some(i=>i.id===id&&i.canDelete)));}}
  catch(e){if(alive.current)setError((e as Error).message);}
  finally{working.current=false;if(alive.current)setBusy(null);}
 },[]);
 useEffect(()=>{void load()},[load]);
 const calculate=async()=>{
  if(working.current||!selected.length)return;working.current=true;setBusy('preview');setError(null);setResult(null);
  try{const next=await window.mados.invoke<StoragePreview>('storage.preview',{ids:selected});if(alive.current)setPreview(next);}
  catch(e){if(alive.current)setError((e as Error).message);}
  finally{working.current=false;if(alive.current)setBusy(null);}
 };
 const clean=async()=>{
  if(working.current||!preview)return;const plan=preview;
  if(!await confirm({title:'Удалить выбранные данные?',message:`Элементов: ${plan.items.length}. Освободится примерно ${storageSize(plan.estimatedBytes)}. Старые игровые сборки при необходимости скачаются заново. Удалённые журналы восстановить нельзя.`,confirmLabel:'Удалить выбранное',destructive:true}))return;
  if(!alive.current||working.current)return;working.current=true;setBusy('clean');setError(null);
  try{const next=await window.mados.invoke<StorageCleanResult>('storage.clean',{planId:plan.planId});if(alive.current){setResult(next);setPreview(null);setSelected([]);}}
  catch(e){if(alive.current){setError((e as Error).message);setPreview(null);}}
  finally{
   // Keep actions locked through the post-clean scan so an older scan cannot replace a newer result.
   if(alive.current) {try{const next=await window.mados.invoke<StorageScan>('storage.scan',{});if(alive.current)setScan(next);}catch{if(alive.current)setError(current=>current??'Не удалось обновить размеры. Нажмите «Обновить».');}}
   working.current=false;if(alive.current)setBusy(null);
  }
 };
 const blocked=scan?.blockedReason||(liveBusy?'Завершите игру или локальный сервер перед очисткой.':null);
 const icons={content:Database,engines:Layers,logs:FileText,localServers:ServerCog};
 return <section className="maintenance-view storage-view" aria-label="Хранилище лаунчера">
  <div className="maintenance-hero"><span className="maintenance-emblem"><HardDrive size={30}/></span><div><span className="eyebrow">Место для новых смен</span><h2>Хранилище Mados</h2><p>Размеры сборок и журналов. Вы сами выбираете, что удалить.</p></div><button className="icon-button" aria-label="Обновить хранилище" disabled={!!busy} onClick={()=>void load()}><RefreshCw size={18} className={busy==='scan'?'spin':''}/></button></div>
  <CacheTransferCard/>
  {error&&<ViewState compact kind="error" title="Действие не завершено" description={error}/>}
  {!scan&&busy&&<ViewState kind="loading" icon={<LoaderCircle className="spin" size={25}/>} title="Считаем занятое место" description="Читаем только каталоги, которыми управляет лаунчер."/>}
  {!scan&&!busy&&error&&<button className="secondary-button" onClick={()=>void load()}><RefreshCw size={16}/>Повторить сканирование</button>}
  {scan&&<><div className="storage-overview"><div><span>Занято лаунчером</span><strong>{storageSize(scan.totalBytes)}</strong></div><div><span>Свободно на диске кэша</span><strong>{scan.freeBytes==null?'—':storageSize(scan.freeBytes)}</strong></div><div className="storage-bar" role="img" aria-label="Распределение занятого места">{scan.categories.filter(c=>c.bytes>0).map((category,index)=><span key={category.id} title={`${category.name}: ${storageSize(category.bytes)}`} style={{width:`${category.bytes/Math.max(1,scan.totalBytes)*100}%`,opacity:1-index*.18}}/>)}</div></div>
   <div className="storage-categories">{scan.categories.map((category,index)=>{const Icon=icons[category.id as keyof typeof icons]??HardDrive;return <article key={category.id} style={{'--item-index':index} as CSSProperties}><Icon size={20}/><strong>{storageSize(category.bytes)}</strong><h3>{category.name}</h3><p>{category.description}</p></article>})}</div>
   {scan.warnings.map(w=><p className="maintenance-notice" key={w}>{w}</p>)}
   {blocked&&<div className="maintenance-notice" role="status"><LockKeyhole size={17}/>{blocked}</div>}
   {result&&<div className="storage-success" role="status"><CheckCircle2 size={22}/><div><strong>Удалено элементов: {result.removedItems}</strong><p>Освобождено на диске: {storageSize(result.freedBytes)}.</p>{result.warnings.map(w=><p key={w}>{w}</p>)}</div></div>}
   <section className="storage-selection"><div className="storage-selection-head"><div><h3>Управление сборками и журналами</h3><p>Последняя использованная версия каждой сборки защищена.</p></div><span>{selected.length} выбрано</span></div>
    {!scan.items.length?<ViewState icon={<ShieldCheck size={25}/>} title="Пока нечего очищать" description="Здесь появятся установленные игровые сборки и журналы."/>:<div className="storage-items">{scan.items.map(item=><label className={`storage-item ${!item.canDelete?'protected':''}`} key={item.id}><input type="checkbox" data-storage-id={item.id} disabled={!!busy||!!blocked||!item.canDelete} checked={selected.includes(item.id)} onChange={e=>{setSelected(ids=>e.target.checked?[...ids,item.id]:ids.filter(id=>id!==item.id));setPreview(null);setResult(null);}}/><span className="storage-item-icon">{item.canDelete?(item.category==='logs'?<FileText size={18}/>:<Database size={18}/>):<LockKeyhole size={18}/>}</span><span><strong>{item.name}</strong><small>{item.protectedReason??(item.lastUsed?`Последнее использование: ${new Date(item.lastUsed).toLocaleDateString()}`:'Старая версия')}</small></span><b>{storageSize(item.bytes)}</b></label>)}</div>}
    <div className="storage-selection-foot"><p>Общие файлы учитываются отдельно в расчёте. Реплеи и ZIP из ваших папок сюда не входят.</p><button className="primary-button" data-action="preview-clean" disabled={!!busy||!!blocked||!selected.length} onClick={()=>void calculate()}>{busy==='preview'?<LoaderCircle className="spin" size={17}/>:<HardDrive size={17}/>}Рассчитать очистку<ArrowRight size={15}/></button></div>
   </section>
   {preview&&<section className="storage-preview" aria-label="Предпросмотр очистки"><span className="maintenance-emblem"><Trash2 size={26}/></span><div><span className="eyebrow">Перед удалением</span><h3>Примерно {storageSize(preview.estimatedBytes)}</h3><p>{preview.items.length} элементов · общие файлы оставшихся сборок сохранятся. Итог зависит от сжатия базы.</p></div><button data-action="clean-storage" className="primary-button" disabled={!!busy||!!blocked} onClick={()=>void clean()}>{busy==='clean'?<LoaderCircle className="spin" size={17}/>:<Trash2 size={17}/>} {busy==='clean'?'Очищаем…':'Удалить выбранное'}</button></section>}
   <p className="maintenance-footnote"><ShieldCheck size={15}/>Аккаунты, избранное, статистика, настройки и данные локальных серверов не входят в очистку.</p>
  </>}
 </section>;
}
