import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Activity, ArrowRight, CalendarDays, Check, Clock3, Gamepad2, Globe2, RefreshCw, ShieldCheck, Trash2, TrendingUp } from "lucide-react";
import type { PlaytimePeriod, PlaytimeSummary } from "../contracts/launcher";
import { playtimeSummarySchema } from "../contracts/schema";
import { useConfirm } from "./ConfirmDialog";
import { LoadingCards, ViewState } from "./ViewState";

export function playtimeDuration(seconds: number, precise = false): string {
  const value = Math.max(0, Math.floor(seconds));
  if (precise) return `${Math.floor(value / 3600)} ч ${Math.floor(value % 3600 / 60)} мин ${value % 60} с`;
  if (!value) return "0 мин";
  if (value < 60) return "Меньше минуты";
  const minutes = Math.floor(value / 60), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return `${days ? `${days} д ` : ""}${hours || days ? `${hours} ч ` : ""}${minutes % 60} мин`;
}
const dateLabel = (value: string) => new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
const periods: {id: PlaytimePeriod; label: string}[] = [{id:"all",label:"Всё время"},{id:"today",label:"Сегодня"},{id:"sevenDays",label:"7 дней"}];

export function PlaytimeView({ accountId, username, onBrowse }: { accountId: string; username: string | null; onBrowse: () => void }) {
  const confirm = useConfirm(accountId);
  const [period, setPeriod] = useState<PlaytimePeriod>("all");
  const [snapshot, setSnapshot] = useState<{summary: PlaytimeSummary; receivedAt: number} | null>(null);
  const [refreshing, setRefreshing] = useState(true), [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0), [hoveredDay, setHoveredDay] = useState<string | null>(null);
  const sequence = useRef(0), alive = useRef(true), clearingRef = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++sequence.current; setRefreshing(true); setError(null);
    try {
      const summary = playtimeSummarySchema.parse(await window.mados.invoke<PlaytimeSummary>("playtime.getSummary", {period}));
      if (!alive.current || sequence.current !== request) return;
      if (summary.accountId !== accountId) throw Error("Аккаунт изменился. Обновите статистику.");
      setSnapshot({summary,receivedAt:performance.now()}); setElapsed(0);
    } catch (caught) { if (alive.current && sequence.current === request) setError((caught as Error).message); }
    finally { if (alive.current && sequence.current === request) setRefreshing(false); }
  }, [accountId, period]);
  const currentRefresh = useRef(refresh); currentRefresh.current = refresh;
  useEffect(() => {
    alive.current = true; setSnapshot(null); void refresh();
    const unsubscribe = window.mados.onEvent(event => {
      const update = event.data as {accountId?:string;active?:boolean;address?:string;startedAt?:string} | null;
      if (event.event !== "playtime.updated" || update?.accountId !== accountId) return;
      if (update.active === false) setSnapshot(current => {
        const active = current?.summary.activeSession;
        if (!current || !active || active.address !== update.address || (update.startedAt && active.startedAt !== update.startedAt)) return current;
        return {...current,summary:{...current.summary,activeSession:null,servers:current.summary.servers.map(server=>server.address===active.address?{...server,active:false}:server)}};
      });
      void refresh();
    });
    return () => { alive.current = false; ++sequence.current; unsubscribe(); };
  }, [accountId, refresh]);
  useEffect(() => {
    if (!snapshot?.summary.activeSession) return;
    const timer = window.setInterval(() => setElapsed(Math.max(0, Math.floor((performance.now() - snapshot.receivedAt) / 1000))), 60_000);
    return () => clearInterval(timer);
  }, [snapshot]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 3500); return () => clearTimeout(timer); }, [notice]);
  const clear = async () => {
    if (clearingRef.current) return;
    clearingRef.current = true;
    if (!await confirm({title:"Удалить историю игры?",message:"Удалятся завершённые сессии этого аккаунта. Текущая игра продолжит считаться, данные других аккаунтов сохранятся.",confirmLabel:"Удалить историю",destructive:true})) { clearingRef.current = false; return; }
    if (!alive.current) return;
    setClearing(true); setError(null);
    try {
      const result = await window.mados.invoke<{removed:number}>("playtime.clear");
      if (!alive.current) return;
      setNotice(result.removed ? "История завершённых сессий удалена" : "Завершённых сессий для удаления нет"); await currentRefresh.current();
    } catch (caught) { if (alive.current) setError((caught as Error).message); }
    finally { clearingRef.current = false; if (alive.current) setClearing(false); }
  };
  const summary = snapshot?.summary, active = summary?.activeSession;
  const days = summary?.dailyActivity ?? [];
  const day = days.find(item=>item.date===hoveredDay);
  const maxDay = Math.max(1, ...days.map(item=>item.totalSeconds));
  const weekTotal = days.reduce((total,item)=>total+item.totalSeconds,0);
  const servers = [...summary?.servers ?? []].sort((a,b)=>b.totalSeconds-a.totalSeconds);
  return <section className="page page-enter playtime-studio">
    <div className="page-heading"><div><p className="eyebrow">Ваше время на станции</p><h1>Время игры</h1><p className="page-subtitle">Личная статистика · {username ?? "Аккаунт"}</p></div><div className="heading-actions">
      <button className="icon-button" aria-label="Обновить статистику" data-tooltip="Обновить" disabled={refreshing} onClick={()=>void refresh()}><RefreshCw size={18} className={refreshing ? "refresh-once" : ""}/></button>
      <button className="icon-button" aria-label="Удалить историю" data-tooltip="Удалить историю" disabled={clearing || !summary?.sessionCount} onClick={()=>void clear()}><Trash2 size={18}/></button>
    </div></div>
    <div className="activity-periods" role="group" aria-label="Период статистики"><CalendarDays size={15}/>{periods.map(item=><button key={item.id} data-period={item.id} aria-pressed={period===item.id} className={period===item.id ? "selected" : ""} onClick={()=>setPeriod(item.id)}>{item.label}</button>)}</div>
    {error && <ViewState compact={!!summary} kind="error" title="Не удалось обновить статистику" description={error} action="Повторить" actionId="retry-playtime" onAction={()=>void refresh()}/>}
    {notice && <div className="inline-success" role="status"><Check size={16}/>{notice}</div>}
    {!summary && refreshing && <LoadingCards count={3} label="Собираем вашу статистику…"/>}
    {summary && <>
      <div className="playtime-overview" key={period}><div className="playtime-total-block"><span className="eyebrow">{periods.find(item=>item.id===period)?.label}</span><strong className="playtime-total">{playtimeDuration(summary.totalSeconds)}</strong><span className="activity-muted">Учтено только время работы игры</span></div><div className="playtime-small-stat"><Activity size={19}/><strong>{summary.sessionCount}</strong><span>Сессий</span></div><div className="playtime-small-stat"><Globe2 size={19}/><strong>{summary.uniqueServers}</strong><span>Серверов</span></div></div>
      {active && <article className="playtime-now"><div className="playtime-now-icon"><Gamepad2 size={25}/></div><div><span className="playtime-now-label"><i/>Сейчас играете</span><h2>{active.name || active.address}</h2><p>{active.address}</p></div><div className="playtime-now-time"><strong className="playtime-live-value">{playtimeDuration(active.elapsedSeconds+elapsed)}</strong><span>Текущая сессия</span></div></article>}
      <section className="playtime-week" aria-label="Недельная активность"><header><div><span className="eyebrow">Ритм недели</span><h2>Последние 7 календарных дней</h2></div><div className="playtime-day-detail" aria-live="polite"><strong>{day ? playtimeDuration(day.totalSeconds,true) : playtimeDuration(weekTotal)}</strong><span>{day ? dateLabel(`${day.date}T12:00:00`) : "Сегодня и шесть предыдущих дней"}</span></div></header>
        {days.length ? <div className="playtime-chart" onMouseLeave={()=>setHoveredDay(null)}>{days.map((item,index)=><button key={item.date} data-day={item.date} className={`playtime-day ${index===days.length-1 ? "today" : ""}`} aria-label={`${dateLabel(`${item.date}T12:00:00`)}: ${playtimeDuration(item.totalSeconds,true)}`} onMouseEnter={()=>setHoveredDay(item.date)} onFocus={()=>setHoveredDay(item.date)} onBlur={()=>setHoveredDay(null)} onClick={()=>setHoveredDay(item.date)}>
          <span className="playtime-bar-track"><span className="playtime-bar" style={{height:`${item.totalSeconds/maxDay*100}%`,"--activity-delay":`${index*35}ms`} as CSSProperties}/></span><span className="playtime-day-name">{index===days.length-1 ? "Сегодня" : new Date(`${item.date}T12:00:00`).toLocaleDateString("ru-RU",{weekday:"short"})}</span><small>{dateLabel(`${item.date}T12:00:00`)}</small>
        </button>)}</div> : <p className="activity-muted">Данные по дням пока недоступны.</p>}
        {days.length>0 && weekTotal===0 && <p className="playtime-chart-caption">На этой неделе пока нет игровых сессий.</p>}
      </section>
      <div className="section-heading"><div><h2>Ваши серверы</h2><span>По времени игры за выбранный период</span></div><TrendingUp size={19} className="muted-icon"/></div>
      {servers.length ? <div className="playtime-ranking">{servers.map((server,index)=>{
        const share = summary.totalSeconds>0 ? Math.min(100,Math.round(server.totalSeconds/summary.totalSeconds*100)) : 0;
        return <article key={server.address} data-server={server.address} className="playtime-rank-card" style={{"--activity-delay":`${Math.min(index,8)*35}ms`} as CSSProperties}><span className="playtime-rank-number">{String(index+1).padStart(2,"0")}</span><div className="playtime-rank-body"><div className="playtime-rank-heading"><div><h3>{server.name || server.address}</h3><p>{server.address}</p></div><strong>{playtimeDuration(server.totalSeconds)}</strong></div><div className="playtime-share" role="meter" aria-label={`Доля времени на ${server.name || server.address}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share} aria-valuetext={`${share}% времени за выбранный период`}><span style={{width:`${share}%`}}/></div><div className="playtime-rank-meta"><span>Сессий: {server.sessionCount} · {share}% времени</span><span>{server.active ? "Сейчас играете" : server.lastPlayedAt ? `Последняя игра ${dateLabel(server.lastPlayedAt)}` : "—"}</span></div></div></article>;
      })}</div> : <ViewState icon={<Clock3 size={26}/>} title={summary.trackedSince ? "В этом периоде пока нет игр" : "Ваша история начинается здесь"} description="После запуска сервера здесь появятся время игры и любимые станции." action="Открыть серверы" onAction={onBrowse}/>}
      <footer className="playtime-privacy"><ShieldCheck size={15}/><span>Хранится только на этом устройстве{summary.trackedSince ? ` · Учёт с ${dateLabel(summary.trackedSince)}` : ""}</span></footer>
    </>}
  </section>;
}
