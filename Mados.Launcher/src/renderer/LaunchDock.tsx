import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Activity, AlertCircle, ArrowRight, Check, ChevronUp, Clock3, Download, Gamepad2, LoaderCircle, Map, RefreshCw, Rocket, ShieldCheck, Users, X } from "lucide-react";
import { formatSessionTime, launchFailed, launchLabel, launchPercent, type LaunchActivity } from "./launch-status";

import { playServerHandoff } from "./server-handoff";
import { useCurrentGame } from "./current-game";

export function LaunchDock({ activity, onDismiss, onOpenServer, onDiagnose }: { activity: LaunchActivity; onDismiss: () => void; onOpenServer?: () => void; onDiagnose?:()=>void }) {
  const dockRef = useRef<HTMLElement>(null);
  const handoffCleanup = useRef<(() => void) | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const game = useCurrentGame(activity);
  const playing = activity.status === "ClientRunning";
  const failed = launchFailed(activity.status);
  const cancelled = activity.status === "Cancelled";
  const policy = activity.status === "AwaitingPrivacyPolicyAcceptance" ? activity.privacyPolicy : null;
  const percent = launchPercent(activity.progress);
  const stage = playing || activity.status === "StartingClient" || activity.status === "Ready" ? 2
    : /Download|Updating|Verifying|Committing|Loading|Culling/.test(activity.status) ? 1 : 0;
  const phase = failed ? "error" : cancelled ? "cancelled" : policy ? "policy" : playing ? "playing"
    : activity.status.startsWith("Downloading") ? "download" : stage === 2 ? "starting" : stage === 1 ? "verify" : "connecting";
  useEffect(() => {
    const target = dockRef.current?.querySelector<HTMLElement>(".launch-dock-icon");
    const cleanup = target ? playServerHandoff(activity.address, "launch", target) : null;
    if (cleanup) { handoffCleanup.current?.(); handoffCleanup.current = cleanup; }
  }, [activity.address, activity.status]);
  useEffect(() => () => handoffCleanup.current?.(), []);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const shell = dock?.closest<HTMLElement>(".app-shell");
    if (!dock || !shell) return;
    // Keep the server inspector above launch controls, including expanded policy/error states.
    const reserveSpace = () => shell.style.setProperty("--launch-dock-clearance", `${dock.offsetHeight + (parseFloat(getComputedStyle(dock).marginBottom) || 0) + 8}px`);
    reserveSpace();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reserveSpace);
    observer?.observe(dock);
    observer?.observe(shell);
    return () => { observer?.disconnect(); shell.style.removeProperty("--launch-dock-clearance"); };
  }, []);
  useEffect(() => {
    setActionError(null); setActing(false);
  }, [activity.status, activity.address]);
  useEffect(() => { setExpanded(false); }, [activity.address, activity.startedAt]);
  useEffect(() => {
    if (!playing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [playing]);
  const action = async (method: "connection.cancel" | "connection.confirmPrivacyPolicy", params?: unknown) => {
    setActing(true); setActionError(null);
    try { await window.mados.invoke(method, params); }
    catch (error) { setActionError((error as Error).message); }
    finally { setActing(false); }
  };
  const title = activity.name || activity.address?.replace(/^ss14s?:\/\//, "") || (activity.contentBundle ? "Контент-бандл" : "Space Station 14");
  const info = game.details, available = info?.status !== "offline";
  const players = available && info?.playerCount != null ? `${info.playerCount}${info.softMaxPlayerCount ? ` / ${info.softMaxPlayerCount}` : ""}` : "—";
  const map = available ? info?.map || "Не указано" : "Не указано";
  return <section ref={dockRef} className={`launch-dock ${playing ? "playing current-game-dock" : ""} ${failed ? "failed" : ""}`} aria-label="Состояние запуска" data-session-state={playing ? "playing" : phase}>
    <div className="launch-dock-row">
      <div key={phase} className="launch-dock-icon" data-phase={phase} aria-hidden="true">{failed ? <AlertCircle size={21} /> : playing ? <Gamepad2 size={22} /> : policy || phase === "verify" ? <ShieldCheck size={21} /> : cancelled ? <X size={19} /> : phase === "download" ? <Download size={21} /> : phase === "starting" ? <Rocket size={21} /> : <LoaderCircle size={21} className="spin" />}</div>
      <div className="launch-dock-copy"><strong data-tooltip={title}>{title}</strong><span aria-live="polite"><span key={activity.status} className="launch-stage-label">{playing && activity.contentBundle ? "Игра запущена" : launchLabel(activity.status)}</span>{playing && activity.startedAt != null && <> <span className="dock-separator">·</span> {formatSessionTime((now - activity.startedAt) / 1000)}</>}{!playing && percent != null && <> <span className="dock-separator">·</span> {percent}%</>}</span></div>
      {playing && !activity.contentBundle && <div className="current-game-inline"><span title={map}><Map size={13}/>{map}</span><span><Users size={13}/>{players}</span></div>}
      <div className="launch-dock-actions">
        {failed&&!activity.contentBundle&&activity.address&&onDiagnose&&<button className="secondary-button compact-button" data-action="diagnose-connection" onClick={onDiagnose}><Activity size={15}/>Диагностика</button>}
        {!playing && !failed && !cancelled && !policy && <button className="ghost-button dock-cancel" disabled={acting} onClick={() => void action("connection.cancel")}><X size={14} />Отменить</button>}
        <button className="icon-button dock-expand" aria-label={expanded ? "Свернуть подробности запуска" : "Подробности запуска"} aria-expanded={expanded || Boolean(policy)} onClick={() => setExpanded(value => !value)}><ChevronUp size={17} className={expanded || policy ? "expanded" : ""} /></button>
        {(failed || cancelled) && <button className="icon-button" aria-label="Закрыть состояние запуска" onClick={onDismiss}><X size={17} /></button>}
      </div>
    </div>
    {!playing && !failed && !cancelled && !policy && <div className={`launch-dock-progress ${percent == null ? "indeterminate" : ""}`} role="progressbar" aria-label="Загрузка игровых файлов" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}><span style={percent == null ? undefined : { width: `${percent}%` }} /></div>}
    {(expanded || policy || failed || actionError) && <div className="launch-dock-details">
      {policy ? <div className="launch-policy"><p>Перед подключением ознакомьтесь с <button className="text-link inline-link" onClick={() => void window.mados.openExternal(policy.link).catch(error => setActionError((error as Error).message))}>политикой сервера</button>.</p><div><button className="secondary-button compact-button" disabled={acting} onClick={() => void action("connection.confirmPrivacyPolicy", { accepted: false })}>Отклонить</button><button data-action="accept-policy" className="primary-button compact-button" disabled={acting} onClick={() => void action("connection.confirmPrivacyPolicy", { accepted: true })}>Принять и продолжить</button></div></div>
        : failed ? <p className="launch-dock-error" role="alert">{activity.reason || "Попробуйте подключиться ещё раз."}</p>
          : playing ? <div className="current-game-content"><div className="current-game-heading"><span className="eyebrow">Ваша текущая смена</span>{!activity.contentBundle&&<button className="icon-button" disabled={game.loading} aria-label="Обновить данные текущего сервера" onClick={()=>void game.refresh()}><RefreshCw size={15} className={game.loading?"spin":""}/></button>}</div><div className="current-game-stats"><div><Clock3 size={16}/><span>В игре</span><strong>{formatSessionTime(Math.max(0,(now-(activity.startedAt??now))/1000))}</strong></div>{!activity.contentBundle&&<><div><Map size={16}/><span>Карта</span><strong>{map}</strong></div><div><Gamepad2 size={16}/><span>Режим</span><strong>{available?info?.mode||"Не указано":"Не указано"}</strong></div><div><Users size={16}/><span>Онлайн</span><strong>{players}</strong></div><div><Activity size={16}/><span>Ping</span><strong>{available&&info?.pingMs!=null?`${info.pingMs} ms`:"—"}</strong></div></>}</div>{game.error&&<p className="launch-dock-error" role="alert">{game.error} · Показаны последние полученные данные.</p>}<div className="current-game-foot"><span>{activity.contentBundle?"Локальный контент · в статистику серверов не входит":"Данные сервера могут меняться во время игры"}</span>{!activity.contentBundle&&onOpenServer&&<button className="text-link" data-action="session-details" onClick={onOpenServer}>О сервере<ArrowRight size={14}/></button>}</div></div>
          : <ol className="launch-stages">{["Проверка", "Игровые файлы", "Запуск"].map((label, index) => {
            const state = index < stage || playing ? "complete" : index === stage ? "current" : "pending";
            return <li key={label} className={state} aria-current={state === "current" ? "step" : undefined}><span key={state}>{state === "complete" ? <Check size={13} /> : index === 0 ? <ShieldCheck size={13} /> : index === 1 ? <Download size={13} /> : <Rocket size={13} />}</span>{label}</li>;
          })}</ol>}
      {actionError && <p className="launch-dock-error" role="alert">{actionError}</p>}
    </div>}
  </section>;
}
