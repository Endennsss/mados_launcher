import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, AlertCircle, Check, ExternalLink, Gamepad2, LoaderCircle, Map, Play, RefreshCw, Save, StickyNote, Trash2, Users, X } from "lucide-react";
import type { Server, ServerDetails, ServerNote } from "../contracts/launcher";
import { mergeServerDetails, sanitizeServerAddress } from "./ui-helpers";

import { playServerHandoff, queueServerHandoff } from "./server-handoff";

export function ServerDetailsPanel({ accountId, server, onClose, onConnect }: { accountId?: string; server: Server; onClose: () => void; onConnect: () => void }) {
  const [details, setDetails] = useState<ServerDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<ServerNote | null>(null);
  const [draft, setDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const sequence = useRef(0);
  const alive = useRef(true);
  const safeAddress = sanitizeServerAddress(server.address);
  useEffect(() => markRef.current ? playServerHandoff(safeAddress, "details", markRef.current) ?? undefined : undefined, [safeAddress]);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true); setError(null);
    try {
      const result = await window.mados.invoke<ServerDetails>("servers.info", { address: server.address, hubAddress: server.hubAddress });
      if (alive.current && request === sequence.current) setDetails(result);
    } catch (caught) {
      if (alive.current && request === sequence.current) setError((caught as Error).message);
    } finally {
      if (alive.current && request === sequence.current) setLoading(false);
    }
  }, [server.address, server.hubAddress]);
  useEffect(() => {
    alive.current = true;
    const previousFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") close.current(); };
    window.addEventListener("keydown", keydown);
    return () => {
      alive.current = false; sequence.current += 1;
      window.removeEventListener("keydown", keydown);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let cancelled = false;
    setNote(null); setDraft(""); setNoteError(null);
    void window.mados.serverNotes.list().then(items => {
      if (cancelled) return;
      const stored = items.find(item => sanitizeServerAddress(item.address) === safeAddress) ?? null;
      setNote(stored); setDraft(stored?.text ?? "");
    }).catch(caught => { if (!cancelled) setNoteError((caught as Error).message); });
    return () => { cancelled = true; };
  }, [safeAddress, accountId]);
  const saveNote = async (remove = false) => {
    setNoteBusy(true); setNoteError(null);
    try {
      const next = remove ? (await window.mados.serverNotes.remove(safeAddress), null) : await window.mados.serverNotes.upsert(safeAddress, draft);
      if (alive.current) { setNote(next); setDraft(next?.text ?? ""); }
    } catch (caught) { if (alive.current) setNoteError((caught as Error).message); }
    finally { if (alive.current) setNoteBusy(false); }
  };
  const effective = mergeServerDetails(server, details ?? {});
  const online = effective.status === "online";
  return createPortal(<aside data-server-address={safeAddress} className="server-inspector" role="dialog" aria-labelledby="server-inspector-title">
    <header className="inspector-toolbar"><span>О сервере</span><div><button className="icon-button" disabled={loading} onClick={() => void load()} aria-label="Обновить данные сервера"><RefreshCw size={16} className={loading ? "spin" : ""} /></button><button ref={closeRef} className="icon-button" aria-label="Закрыть описание сервера" onClick={onClose}><X size={18} /></button></div></header>
    <div className="inspector-scroll">
      <div className="inspector-heading">
        <div className="inspector-identity"><div ref={markRef} className="inspector-server-icon server-mark"><Gamepad2 size={25} strokeWidth={1.8} /></div><span className={`inspector-status ${online ? "online" : ""}`}><i />{loading ? "Проверяем статус" : error ? "Статус недоступен" : online ? "Онлайн" : "Недоступен"}</span></div>
        <h2 id="server-inspector-title">{effective.name || safeAddress || "Сервер"}</h2><p>{safeAddress || "Адрес скрыт"}</p>
      </div>
      <dl className="inspector-metrics"><div><dt><Users size={14} /> Игроки</dt><dd>{!error && online && details?.playerCount != null ? <>{details.playerCount}{effective.softMaxPlayerCount > 0 ? <small> / {effective.softMaxPlayerCount}</small> : null}</> : "—"}</dd></div><div><dt><Activity size={14} /> Задержка</dt><dd>{error || !online || effective.pingMs == null ? "—" : <>{effective.pingMs}<small> ms</small></>}</dd></div></dl>
      <dl className="inspector-facts"><div><dt><Map size={14} /> Карта</dt><dd>{effective.map?.trim() || "Не указано"}</dd></div><div><dt><Gamepad2 size={14} /> Режим</dt><dd>{effective.mode?.trim() || "Не указано"}</dd></div></dl>
      <section className="inspector-description"><h3>Об этой станции</h3>{loading && !details ? <p className="inspector-loading"><LoaderCircle size={15} className="spin" /> Загружаем описание…</p> : error ? <div className="inspector-error" role="alert"><AlertCircle size={16} /><p>{error}</p><button className="text-link" onClick={() => void load()}>Повторить</button></div> : <><p>{details?.description?.trim() || "Создатели сервера пока не добавили описание."}</p>{Boolean(details?.links?.length) && <div className="inspector-links">{details!.links!.map(link => <button key={link.url} onClick={() => void window.mados.openExternal(link.url).catch(caught => setError((caught as Error).message))}>{link.name || "Ссылка сервера"}<ExternalLink size={14} /></button>)}</div>}</>}</section>
      <details className="inspector-note" open={Boolean(note)}><summary><StickyNote size={16} /> Моя заметка{note && <Check size={14} />}</summary><p>Только для вашего аккаунта</p><textarea aria-label="Заметка о сервере" rows={3} maxLength={4000} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Что стоит помнить об этом сервере?" />{noteError && <p className="inspector-note-error" role="alert">{noteError}</p>}<div className="inspector-note-actions"><button className="icon-button" aria-label="Удалить заметку" disabled={noteBusy || !note} onClick={() => void saveNote(true)}><Trash2 size={15} /></button><button className="secondary-button compact-button" disabled={noteBusy || !safeAddress} onClick={() => void saveNote()}>{noteBusy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} Сохранить</button></div></details>
    </div>
    <footer className="inspector-footer"><button className="primary-button" disabled={!online} onClick={event => { queueServerHandoff(safeAddress, event.currentTarget, "launch"); onConnect(); }}><Play size={16} className="play-icon" fill="currentColor" /> Подключиться</button><span>{online ? "Начните новую смену" : "Сервер сейчас недоступен"}</span></footer>
  </aside>, document.querySelector(".app-shell") ?? document.body);
}
