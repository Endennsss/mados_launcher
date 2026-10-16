import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Check, Clock3, Gamepad2, Play, RefreshCw, X } from "lucide-react";
import type { PlaytimeSummary } from "../contracts/launcher";
import { formatSessionTime } from "./launch-status";
import { parseCompletedSession, type CompletedSession } from "./home-personalization";
import { sanitizeServerAddress } from "./ui-helpers";

const duration = (seconds: number) => seconds > 0 && seconds < 60 ? "Меньше минуты" : formatSessionTime(seconds);

export function WeeklyPlaytime({ accountId, onOpen }: { accountId: string; onOpen: () => void }) {
  const [summary, setSummary] = useState<PlaytimeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current; setLoading(true); setError(null);
    try {
      const next = await window.mados.invoke<PlaytimeSummary>("playtime.getSummary", { period: "sevenDays" });
      if (request !== sequence.current) return;
      if (next.accountId !== accountId) throw new Error("Аккаунт изменился. Обновите статистику.");
      setSummary(next);
    } catch (caught) { if (request === sequence.current) setError((caught as Error).message); }
    finally { if (request === sequence.current) setLoading(false); }
  }, [accountId]);
  useEffect(() => {
    void refresh();
    const unsubscribe = window.mados.onEvent(event => {
      if (event.event === "playtime.updated" && (event.data as { accountId?: string })?.accountId === accountId) void refresh();
    });
    return () => { ++sequence.current; unsubscribe(); };
  }, [accountId, refresh]);
  const top = summary?.servers.reduce<PlaytimeSummary["servers"][number] | null>((best, server) => !best || server.totalSeconds > best.totalSeconds ? server : best, null);
  return <section className="home-week" aria-label="Моя неделя" aria-busy={loading}>
    <div className="home-week-heading"><div><span className="eyebrow">За последние 7 дней</span><h2><Clock3 size={19} />Моя неделя</h2></div><button className="ghost-button" onClick={onOpen}>Время игры <ArrowRight size={16} className="action-arrow" /></button></div>
    {error ? <div className="home-feedback" role="alert">{error}<button className="ghost-button" onClick={() => void refresh()}><RefreshCw size={15} />Повторить</button></div> : !summary ? <p className="home-muted">Загружаем время игры…</p> : <>
      <div className="home-week-metrics"><div><strong>{duration(summary.totalSeconds)}</strong><span>в игре</span></div><div><strong>{summary.sessionCount}</strong><span>сессий</span></div><div><strong>{summary.uniqueServers}</strong><span>серверов</span></div></div>
      <p className="home-week-caption">{top ? <>Больше всего времени на <strong>{top.name || top.address.replace(/^ss14s?:\/\//, "")}</strong></> : "Первая игра этой недели появится здесь. Время загрузки не учитывается."}</p>
    </>}
  </section>;
}

export function SessionRecap({ accountId, launchBusy, onOpenPlaytime }: { accountId: string; launchBusy: boolean; onOpenPlaytime: () => void }) {
  const [session, setSession] = useState<CompletedSession | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [totalError, setTotalError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [retry, setRetry] = useState(0);
  const seen = useRef(new Set<string>());
  const currentId = useRef<string | null>(null);
  const dock = useRef<HTMLElement>(null);
  const clear = useCallback(() => { currentId.current = null; setSession(null); setActing(false); setActionError(null); }, []);
  useEffect(() => {
    const unsubscribe = window.mados.onEvent(event => {
      if (event.event === "connection.started" || event.event === "auth.changed") { clear(); return; }
      if (event.event !== "playtime.updated") return;
      const data = event.data as { accountId?: string; active?: boolean; cleared?: number } | null;
      if (data?.accountId !== accountId) return;
      if (data.cleared != null) { clear(); return; }
      if (data.active === true) {
        // Heartbeat delivery can race completion after the tracker releases its lock.
        const active = parseCompletedSession({ ...data, active: false }, accountId);
        if (active && !seen.current.has(active.id)) clear();
        return;
      }
      const completed = parseCompletedSession(data, accountId);
      if (!completed || seen.current.has(completed.id)) return;
      seen.current.add(completed.id);
      if (seen.current.size > 100) seen.current.delete(seen.current.values().next().value!);
      currentId.current = completed.id; setTotal(null); setTotalError(null); setActionError(null); setActing(false); setSession(completed);
    });
    return () => { currentId.current = null; unsubscribe(); };
  }, [accountId, clear]);
  useEffect(() => {
    if (!session) return;
    let cancelled = false; setTotalError(null);
    void window.mados.invoke<PlaytimeSummary>("playtime.getSummary", { period: "all" }).then(summary => {
      if (cancelled || currentId.current !== session.id) return;
      if (summary.accountId !== accountId) throw new Error("Аккаунт изменился. Обновите итог.");
      const server = summary.servers.find(item => sanitizeServerAddress(item.address) === session.address);
      if (!server) throw new Error("Итог по серверу пока недоступен.");
      setTotal(server.totalSeconds);
    }).catch(caught => { if (!cancelled && currentId.current === session.id) setTotalError((caught as Error).message); });
    return () => { cancelled = true; };
  }, [session, accountId, retry]);
  useLayoutEffect(() => {
    const element = dock.current, shell = element?.closest<HTMLElement>(".app-shell");
    if (!element || !shell) return;
    const reserve = () => shell.style.setProperty("--session-recap-clearance", `${element.offsetHeight + (parseFloat(getComputedStyle(element).marginBottom) || 0) + 8}px`);
    reserve(); const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reserve); observer?.observe(element);
    return () => { observer?.disconnect(); shell.style.removeProperty("--session-recap-clearance"); };
  }, [session?.id, launchBusy]);
  const reconnect = async () => {
    if (!session || acting || launchBusy) return;
    setActing(true); setActionError(null); const id = session.id;
    try { await window.mados.invoke("servers.connect", { address: session.address, name: session.name }); if (currentId.current === id) clear(); }
    catch (caught) { if (currentId.current === id) setActionError((caught as Error).message); }
    finally { if (currentId.current === id) setActing(false); }
  };
  // Completion precedes ClientExited. Show one footer at a time, including dismissible launch errors.
  if (!session || launchBusy) return null;
  return <section ref={dock} key={session.id} className="session-recap" aria-label="Итоги игры">
    <div className="session-recap-heading"><div className="session-recap-mark" aria-hidden="true"><Gamepad2 size={23} /><Check size={12} /></div><div className="session-recap-title"><span className="eyebrow">С возвращением</span><h2>{session.name || session.address.replace(/^ss14s?:\/\//, "")}</h2><span className="home-muted">Игра завершена · время сохранено</span></div><button className="icon-button session-recap-close" aria-label="Закрыть итоги игры" data-tooltip="Закрыть итоги" onClick={clear}><X size={17} /></button></div>
    <div className="session-recap-bottom"><div className="session-recap-stats" aria-live="polite"><div><strong>{duration(session.elapsedSeconds)}</strong><span>эта сессия</span></div><div><strong>{total == null ? "—" : duration(total)}</strong><span>всего на сервере</span></div></div><div className="session-recap-actions"><button className="ghost-button" onClick={onOpenPlaytime}><Clock3 size={16} />Статистика</button><button className="primary-button compact-button" disabled={acting} onClick={() => void reconnect()}><Play size={15} />Вернуться на сервер</button></div></div>
    {totalError && <div className="home-feedback" role="alert">{totalError}<button className="ghost-button" onClick={() => setRetry(value => value + 1)}>Повторить</button></div>}
    {actionError && <p className="home-feedback" role="alert">{actionError}</p>}
  </section>;
}
