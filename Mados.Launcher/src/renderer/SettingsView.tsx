import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Check, ChevronDown, ExternalLink, Languages, LoaderCircle, Search, X } from "lucide-react";
import type { DiscordPresenceStatus, Settings, ShellUpdateState } from "../contracts/launcher";
import { ThemePicker, useLauncherTheme } from "./ThemePicker";
import { LauncherUpdateView } from "./LauncherUpdateView";
import { SelectField } from "./SelectField";
import { SearchMatch } from "./CommandPalette";
import { searchSettings, settingById, settingsSections, type SettingId, type SettingSearchRequest, type SettingsSection } from "./settings-search";

export function SettingsView({ request, settings, setSettings, themeController, discordStatus, shellUpdate, launchBusy }: {
  request?: SettingSearchRequest | null; settings: Settings | null; setSettings: (settings: Settings) => void;
  themeController: ReturnType<typeof useLauncherTheme>; discordStatus: DiscordPresenceStatus; shellUpdate: ShellUpdateState; launchBusy: boolean;
}) {
  const [section, setSection] = useState<SettingsSection>(request ? settingById(request.id).section : "account");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<SettingSearchRequest | null>(request ?? null);
  const [saving, setSaving] = useState<SettingId | null>(null);
  const [saved, setSaved] = useState<SettingId | null>(null);
  const [error, setError] = useState<{id: SettingId; message: string} | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => localStorage.getItem("mados.reducedMotion") === "true");
  const page = useRef<HTMLElement>(null), search = useRef<HTMLInputElement>(null), live = useRef(true);
  const ready = Boolean(settings);
  useEffect(() => { live.current = true;return () => {live.current=false;}; }, []);
  const select = (id: SettingId) => { setQuery("");setSection(settingById(id).section);setTarget(current=>({id,revision:(current?.revision ?? 0)+1})); };
  useEffect(() => { if(request) select(request.id); }, [request]);
  useLayoutEffect(() => {
    if(!target || !settings || query) return;
    const element=page.current?.querySelector<HTMLElement>(`[data-setting-id="${target.id}"]`);
    if(element instanceof HTMLDetailsElement) element.open=true;
    element?.focus({preventScroll:true});element?.scrollIntoView?.({block:"nearest",behavior:"instant"});
    const timer=window.setTimeout(()=>setTarget(null),2400);
    return ()=>clearTimeout(timer);
  },[target,section,ready,query]);
  useEffect(()=>{if(!saved)return;const timer=window.setTimeout(()=>setSaved(null),2600);return()=>clearTimeout(timer);},[saved]);

  if (!settings) return <div className="settings-loading" role="status"><LoaderCircle className="spin" size={20}/>Загружаем настройки…</div>;
  const update = async (id: SettingId, patch: Partial<Settings>) => {
    if(saving)return;setSaving(id);setSaved(null);setError(null);
    try { const next=await window.mados.invoke<Settings>("settings.update",patch);if(live.current){setSettings(next);setSaved(id);} }
    catch(caught){if(live.current)setError({id,message:(caught as Error).message});}
    finally{if(live.current)setSaving(null);}
  };
  const anchor = (id: SettingId) => ({"data-setting-id":id, tabIndex:-1, className:`setting-anchor ${target?.id===id ? "setting-found" : ""}`});
  const row = (id: SettingId, children: ReactNode) => {
    const item=settingById(id);
    return <div {...anchor(id)} className={`setting-row ${anchor(id).className}`}><div><strong>{item.title}</strong><p>{item.description}</p>{saved===id && <span className="setting-saved" role="status"><Check size={13}/>Сохранено</span>}{error?.id===id && <span className="setting-save-error" role="alert"><AlertTriangle size={13}/>{error.message}</span>}</div><div className="setting-control">{saving===id && <LoaderCircle size={14} className="spin"/>}{children}</div></div>;
  };
  const toggle = (id: SettingId, checked: boolean, change: (checked:boolean)=>void, disabled=false) => <button className={`toggle ${checked ? "checked" : ""}`} role="switch" aria-label={settingById(id).title} aria-checked={checked} disabled={Boolean(saving)||disabled} onClick={()=>change(!checked)}><span/></button>;
  const currentSection=settingsSections.find(item=>item.id===section)!, Icon=currentSection.icon;
  const results=searchSettings(query), searching=Boolean(query.trim());
  const discordLabel=discordStatus==="connected" ? "Discord подключён" : discordStatus==="disabled" ? "Rich Presence отключён" : "Discord не найден";
  return <section ref={page} className="page page-enter settings-page">
    <div className="page-heading"><div><p className="eyebrow">Персонализация</p><h1>Настройки</h1><p className="page-subtitle">Управляйте аккаунтом и поведением лаунчера.</p></div></div>
    {error && (searching || section!==settingById(error.id).section) && <div className="settings-save-alert" role="alert"><AlertTriangle size={17}/><span><strong>{settingById(error.id).title}</strong>{error.message}</span><button className="ghost-button" data-action="return-to-failed-setting" onClick={()=>select(error.id)}>К настройке<ArrowRight size={14}/></button></div>}
    <div className="settings-search"><Search size={20}/><input ref={search} value={query} aria-label="Поиск по настройкам" placeholder="Найти настройку: тема, Discord, анимации…" onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{
      if(event.key==="Escape"){event.stopPropagation();setQuery("");}
      if(event.key==="ArrowDown" && searching){event.preventDefault();page.current?.querySelector<HTMLButtonElement>('[data-setting-result]')?.focus();}
      if(event.key==="Enter" && searching && results.length===1){event.preventDefault();select(results[0].id);}
    }}/>{query && <button className="icon-button" aria-label="Очистить поиск настроек" onClick={()=>{setQuery("");search.current?.focus();}}><X size={16}/></button>}<span className="settings-search-hint">Быстрый переход</span></div>
    {searching ? <section className="settings-search-results" aria-label="Найденные настройки"><header><span>Результаты поиска</span><span aria-live="polite">{results.length}</span></header>{results.map(item=>{const ItemIcon=item.icon;return <button key={item.id} data-setting-result={item.id} onClick={()=>select(item.id)}><span className="search-result-icon"><ItemIcon size={19}/></span><span><small>{settingsSections.find(section=>section.id===item.section)!.label}</small><strong><SearchMatch text={item.title} query={query}/></strong><span>{item.description}</span></span><ArrowRight size={17}/></button>;})}{!results.length && <div className="settings-search-empty"><Search size={28}/><strong>Такой настройки не найдено</strong><span>Попробуйте другое слово, например «язык» или «логи».</span></div>}</section> :
    <div className="settings-layout"><nav className="settings-nav" aria-label="Разделы настроек">{settingsSections.map(({id,label,icon:NavIcon})=><button key={id} className={`settings-nav-item ${section===id ? "active" : ""}`} onClick={()=>{setSection(id);setTarget(null);}}><NavIcon className="settings-nav-icon" size={16}/>{label}</button>)}</nav>
      <div className="settings-panels"><div key={section} className="settings-section-enter">
        {section==="updates" ? <div {...anchor("updates")}><LauncherUpdateView update={shellUpdate} expanded launchBusy={launchBusy}/></div> : <section className="settings-group"><div className="settings-group-title"><span className="settings-group-icon"><Icon size={18}/></span><h2>{currentSection.label}</h2></div><div className="settings-rows">
          {section==="account" && <>{row("account",<span className="setting-value"><span className="status-dot"/>Активен</span>)}{row("account-management",<button className="secondary-button" onClick={()=>void window.mados.openExternal(settings.accountManagementUrl)}>Открыть<ExternalLink size={14}/></button>)}</>}
          {section==="appearance" && <><div {...anchor("theme")}><ThemePicker {...themeController}/></div>{row("motion",toggle("motion",reducedMotion,checked=>{
            try{localStorage.setItem("mados.reducedMotion",String(checked));setReducedMotion(checked);document.documentElement.classList.toggle("reduce-motion",checked);setSaved("motion");setError(null);}catch{setError({id:"motion",message:"Не удалось сохранить настройку. Попробуйте ещё раз."});}
          }))}{row("minimize-on-play",toggle("minimize-on-play",settings.minimizeOnPlay??false,checked=>void update("minimize-on-play",{minimizeOnPlay:checked})))}{row("restore-after-play",toggle("restore-after-play",settings.restoreAfterPlay??false,checked=>void update("restore-after-play",{restoreAfterPlay:checked})))}{row("notifications",toggle("notifications",settings.favoriteAvailabilityNotifications,checked=>void update("notifications",{favoriteAvailabilityNotifications:checked})))}{row("language",<SelectField label="Язык интерфейса" value={settings.language ?? "auto"} disabled={Boolean(saving)} onChange={value=>void update("language",{language:value==="auto"?null:value})} icon={<Languages size={15}/>} options={[{value:"auto",label:"Системный"},{value:"ru",label:"Русский"},{value:"en-US",label:"English"}]}/>)}</>}
          {section==="discord" && <>{row("presence",toggle("presence",settings.discordPresenceEnabled,checked=>void update("presence",{discordPresenceEnabled:checked})))}{row("nickname",toggle("nickname",settings.discordPresenceShowNickname,checked=>void update("nickname",{discordPresenceShowNickname:checked}),!settings.discordPresenceEnabled))}{row("discord-status",<span className={`setting-value discord-status-value ${discordStatus==="connected"?"success":discordStatus==="disabled"?"muted":"warning"}`}><span className="status-dot"/>{discordLabel}</span>)}<details {...anchor("discord-image")} className={`discord-advanced ${anchor("discord-image").className}`}><summary><span><strong>Расширенные настройки</strong><small>Дополнительная картинка для Discord не обязательна</small></span><ChevronDown size={15}/></summary><div className="discord-advanced-body"><p>Rich Presence работает и без картинки. Asset <code>mados-cat</code> добавляет большую иллюстрацию в Discord-статус.</p><button className="secondary-button" onClick={()=>void window.mados.openExternal("https://discord.com/developers/applications/1555589477492199434/rich-presence/assets")}>Открыть инструкцию<ExternalLink size={14}/></button></div></details></>}
          {section==="compatibility" && <>{row("compatibility",toggle("compatibility",settings.compatMode,checked=>void update("compatibility",{compatMode:checked})))}{row("assets",toggle("assets",settings.overrideAssets,checked=>void update("assets",{overrideAssets:checked})))}</>}
          {section==="diagnostics" && <>{row("logging",toggle("logging",settings.verboseLogging,checked=>void update("logging",{verboseLogging:checked})))}{row("version",<span className="setting-value">{shellUpdate.currentVersion}</span>)}</>}
        </div></section>}
      </div></div>
    </div>}
  </section>;
}
