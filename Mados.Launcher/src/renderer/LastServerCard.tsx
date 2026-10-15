import { useEffect, useState } from "react";
import { ArrowRight, Clock3, Gamepad2, History, LoaderCircle, Play, Radio, Users } from "lucide-react";
import type { PlaytimeSummary, RecentConnection, Server, ServerDetails } from "../contracts/launcher";
import { formatSessionTime } from "./launch-status";
import { sanitizeServerAddress } from "./ui-helpers";

import { queueServerHandoff } from "./server-handoff";

export function LastServerCard({ server, recent, accountId, busy, playing, loading, onConnect, onBrowse, onDetails }: {
  server: Server | null; recent?: RecentConnection; accountId?: string; busy: boolean; playing: boolean; loading: boolean;
  onConnect: (server: Server) => void; onBrowse: () => void; onDetails: (server: Server) => void;
}) {
  const [details, setDetails] = useState<ServerDetails | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(false);
  const address = sanitizeServerAddress(server?.address);
  useEffect(() => {
    let cancelled = false;
    setDetails(null); setSeconds(null); setError(false);
    if (!address) return;
    setChecking(true);
    void window.mados.invoke<ServerDetails>("servers.info", { address, hubAddress: server?.hubAddress ?? "" })
      .then(result => { if (!cancelled) setDetails(result); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setChecking(false); });
    const loadTime = () => {
      void window.mados.invoke<PlaytimeSummary>("playtime.getSummary", { period: "all" }).then(summary => {
        if (!cancelled && summary.accountId === accountId) setSeconds(summary.servers.find(item => sanitizeServerAddress(item.address) === address)?.totalSeconds ?? 0);
      }).catch(() => { if (!cancelled) setSeconds(null); });
    };
    loadTime();
    const unsubscribe = window.mados.onEvent(event => {
      if (event.event === "playtime.updated" && (event.data as { accountId?: string }).accountId === accountId) loadTime();
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [address, accountId, server?.hubAddress]);
  const name = details?.name || server?.name || address.replace(/^ss14s?:\/\//, "");
  const available = details?.status === "online";
  return <section data-server-address={address} className={`last-server-card ${server ? "" : "empty"}`} aria-label="Последний сервер">
    <div className="last-server-art" aria-hidden="true"><div className="station-orbit" /><div className="station-tile"><Gamepad2 size={70} strokeWidth={1.3} /></div><span className="station-signal"><Radio size={17} /></span></div>
    <div className="last-server-content">
      <div className="last-server-topline"><span className="eyebrow">{recent ? "Вернуться на станцию" : server ? "Продолжить знакомство" : "Ваша следующая смена"}</span>{server && <span className={`last-server-status ${available ? "online" : ""}`}><i />{checking ? "Проверяем статус" : error ? "Статус недоступен" : available ? "Сервер онлайн" : "Сервер недоступен"}</span>}</div>
      <h2>{server ? name : loading ? "Находим вашу станцию…" : "Начните новую историю"}</h2>
      <p className="last-server-subtitle">{server ? address.replace(/^ss14s?:\/\//, "") : "Выберите сервер и отправляйтесь в первую смену."}</p>
      {server && <dl className="last-server-stats">
        <div><dt><Users size={14} /> Онлайн</dt><dd>{available && details.playerCount != null ? `${details.playerCount}${details.softMaxPlayerCount ? ` / ${details.softMaxPlayerCount}` : ""}` : "—"}</dd></div>
        <div><dt><Clock3 size={14} /> Вы играли</dt><dd>{seconds == null ? "—" : formatSessionTime(seconds)}</dd></div>
        <div><dt><History size={14} /> Последний визит</dt><dd>{recent ? new Date(recent.lastConnectedAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) : "Ещё не играли"}</dd></div>
      </dl>}
      <div className="last-server-actions"><button className="primary-button" disabled={busy || loading} onClick={event => { if (server) { queueServerHandoff(address, event.currentTarget, "launch"); onConnect(server); } else onBrowse(); }}>{playing ? <Gamepad2 size={17} /> : busy ? <LoaderCircle size={17} className="spin" /> : <Play size={16} className="play-icon" fill="currentColor" />}{playing ? "Игра запущена" : server ? "Подключиться" : "Выбрать сервер"}</button>{server && <button className="last-server-details" onClick={event => { queueServerHandoff(address, event.currentTarget, "details"); onDetails(server); }}>О сервере <ArrowRight size={15} className="action-arrow" /></button>}</div>
    </div>
  </section>;
}
