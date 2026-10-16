import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, Clock3, Edit3, LoaderCircle, Play, Plus, Rocket, Save, Trash2, X } from "lucide-react";
import { hasLaunchProfileValidationErrors, normalizeLaunchProfileDraft, sortLaunchProfiles, validateLaunchProfileDraft, type LaunchProfile, type LaunchProfileDraft, type LaunchProfileValidation } from "./launch-profiles";
import { LoadingCards, ViewState } from "./ViewState";

export type ProfileLoadState = { loading?:boolean; error?:string|null; onRetry?:()=>void; scopeKey?:string };
export type LaunchProfilesProps = ProfileLoadState & {
  profiles:LaunchProfile[]; busy?:boolean;
  onUse:(profile:LaunchProfile)=>void|Promise<void>; onCreate:(draft:LaunchProfileDraft)=>void|Promise<void>;
  onUpdate:(id:string,draft:LaunchProfileDraft)=>void|Promise<void>; onRemove:(profile:LaunchProfile)=>void|Promise<void>;
};
const emptyDraft:LaunchProfileDraft={name:"",address:""};
export function LaunchProfiles(props:LaunchProfilesProps) {return <ProfileCards key={props.scopeKey ?? "profiles"} {...props}/>;}
function ProfileCards({profiles,busy=false,loading=false,error:loadError,onRetry,onUse,onCreate,onUpdate,onRemove}:LaunchProfilesProps) {
  const sorted=useMemo(()=>sortLaunchProfiles(profiles),[profiles]);
  const [editor,setEditor]=useState<string|null>(null),[draft,setDraft]=useState<LaunchProfileDraft>(emptyDraft),[errors,setErrors]=useState<LaunchProfileValidation>({});
  const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[pending,setPending]=useState<string|null>(null),[active,setActive]=useState<string|null>(null);
  const locked=useRef(false),alive=useRef(true),trigger=useRef<HTMLElement|null>(null);
  const restoreFocus=useRef(false),newButton=useRef<HTMLButtonElement>(null);
  useLayoutEffect(()=>{
    if(restoreFocus.current&&editor===null&&!pending&&!busy){
      restoreFocus.current=false;
      (trigger.current?.isConnected?trigger.current:newButton.current)?.focus({preventScroll:true});
    }
  },[editor,pending,busy]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const editing=editor===null?null:profiles.find(profile=>profile.id===editor);
  const closeEditor=()=>{restoreFocus.current=true;setEditor(null);setErrors({});};
  const openEditor=(id:string,element:HTMLElement)=>{trigger.current=element;setEditor(id);const profile=profiles.find(item=>item.id===id);setDraft(profile?{name:profile.name,address:profile.address}:emptyDraft);setErrors({});setError(null);setNotice(null);};
  const run=async(id:string,action:()=>Promise<void>|void,success?:()=>void)=>{
    if(locked.current||busy)return;locked.current=true;setPending(id);setError(null);setNotice(null);
    try{await action();if(alive.current)success?.();}catch(caught){if(alive.current)setError(caught instanceof Error?caught.message:"Не удалось выполнить действие. Повторите попытку.");}
    finally{locked.current=false;if(alive.current)setPending(null);}
  };
  const submit=async(event:FormEvent)=>{
    event.preventDefault();const next=validateLaunchProfileDraft(draft);setErrors(next);if(hasLaunchProfileValidationErrors(next))return;
    if(editor!=="new"&&!editing){setError("Этот профиль уже удалён. Закройте редактор и обновите список.");return;}
    await run("save",()=>editor==="new"?onCreate(normalizeLaunchProfileDraft(draft)):onUpdate(editor!,normalizeLaunchProfileDraft(draft)),()=>{closeEditor();setNotice(editor==="new"?"Профиль создан":"Профиль сохранён");});
  };
  const form=()=> <form className="launch-profile-form profile-inline-editor" onSubmit={event=>void submit(event)} onKeyDown={event=>{if(event.key==="Escape"&&!pending){event.stopPropagation();closeEditor();}}}>
    <div className="launch-profile-form-heading"><strong>{editor==="new"?"Новый профиль":"Изменить профиль"}</strong><button type="button" className="icon-button" aria-label="Закрыть редактор профиля" disabled={!!pending} onClick={closeEditor}><X size={15}/></button></div>
    <div className="profile-form-fields"><label>Название<input autoFocus disabled={busy||!!pending} value={draft.name} maxLength={80} onChange={event=>setDraft({...draft,name:event.target.value})} placeholder="Вечерняя смена" aria-invalid={!!errors.name}/>{errors.name&&<small className="form-error">{errors.name}</small>}</label><label>Адрес сервера<input disabled={busy||!!pending} value={draft.address} maxLength={2048} onChange={event=>setDraft({...draft,address:event.target.value})} placeholder="ss14://station.example" aria-invalid={!!errors.address}/>{errors.address&&<small className="form-error">{errors.address}</small>}</label></div>
    <div className="profile-form-footer"><span>Профиль сохранится для текущего аккаунта</span><button type="submit" className="primary-button compact-button" disabled={busy||!!pending}>{pending==="save"?<LoaderCircle size={15} className="spin"/>:<Save size={15}/>} {editor==="new"?"Создать профиль":"Сохранить"}</button></div>
  </form>;
  return <section className="launch-profiles profile-studio" aria-label="Профили запуска">
    <div className="launch-profiles-heading"><div className="profile-heading-copy"><span className="profile-heading-icon"><Rocket size={22}/></span><div><h2>Профили запуска</h2><span>Один клик до любимой станции</span></div></div><button ref={newButton} className="secondary-button compact-button" disabled={busy||!!pending||editor==="new"} onClick={event=>openEditor("new",event.currentTarget)}><Plus size={15}/>Новый профиль</button></div>
    {(error||loadError)&&<ViewState compact kind="error" title={error?"Действие не завершено":"Не удалось загрузить профили"} description={error||loadError||undefined} action={!error&&onRetry?"Повторить":undefined} onAction={onRetry} onDismiss={error?()=>setError(null):undefined}/>}
    {notice&&<p className="profile-feedback" role="status"><Check size={15}/>{notice}</p>}
    {editor==="new"&&form()}
    {loading&&!profiles.length?<LoadingCards count={2} label="Загружаем профили…"/>:<div className="launch-profile-list">{sorted.map(profile=><article className={`launch-profile-card ${active===profile.id||editor===profile.id?"profile-selected":""}`} key={profile.id} data-profile-id={profile.id}>
      <div className="profile-card-main"><span className="profile-card-mark"><Rocket size={22}/></span><div className="launch-profile-copy"><strong>{profile.name}</strong><span>{profile.address}</span><small><Clock3 size={12}/>{profile.lastUsedAt&&Number.isFinite(Date.parse(profile.lastUsedAt))?`Последний запуск: ${new Date(profile.lastUsedAt).toLocaleString("ru-RU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}`:"Ещё не запускали"}</small></div><div className="launch-profile-actions"><button type="button" className="primary-button compact-button" disabled={busy||!!pending} onClick={()=>void run(profile.id,()=>onUse(profile),()=>{setActive(profile.id);setNotice("Подключение запрошено");})}>{pending===profile.id?<LoaderCircle size={14} className="spin"/>:<Play className="play-icon" size={14} fill="currentColor"/>}Играть</button><button type="button" className="icon-button" disabled={busy||!!pending} aria-label={`Изменить профиль ${profile.name}`} aria-expanded={editor===profile.id} onClick={event=>editor===profile.id?closeEditor():openEditor(profile.id,event.currentTarget)}><Edit3 size={15}/></button><button type="button" className="icon-button danger-icon" disabled={busy||!!pending} aria-label={`Удалить профиль ${profile.name}`} onClick={()=>void run(`remove-${profile.id}`,()=>onRemove(profile))}><Trash2 size={15}/></button></div></div>
      {editor===profile.id&&form()}
    </article>)}</div>}
    {!loading&&!loadError&&!profiles.length&&editor!=="new"&&<ViewState icon={<Rocket size={27}/>} title="Быстрый старт вашей смены" description="Сохраните название и адрес станции. Профиль появится здесь и в поиске Ctrl+K." action="Создать профиль" onAction={()=>openEditor("new",newButton.current!)}/>}
    {profiles.length>0&&<div className="profile-studio-foot"><span>{profiles.length} сохранено · последние запуски выше</span><span>Доступны в Ctrl+K <ArrowRight size={12}/></span></div>}
  </section>;
}
