import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check, ChevronDown, LoaderCircle, LogIn, LogOut, Plus, ShieldCheck, X } from "lucide-react";
import type { Account, LauncherState } from "../contracts/launcher";
import { beginAccountTransition } from "./account-transition";

function initials(name: string | null | undefined) {
  const parts = (name?.trim() || "Mados").split(/[\s_.-]+/);
  return (parts.length > 1 ? parts.slice(0, 2).map(part => Array.from(part)[0]).join("") : Array.from(parts[0]).slice(0, 2).join("")).toLocaleUpperCase();
}
function status(account: Account | null | undefined) {
  if (account?.status === "expired") return "Сессия истекла";
  if (account?.status === "available") return account.active ? "Активен" : "Готов к входу";
  return "Сессия не проверена";
}

export function AccountSwitcher({ state, onStateChange, onAddAccount, onReauthenticate }: {
  state: LauncherState; onStateChange: (state: LauncherState) => void;
  onAddAccount: () => void; onReauthenticate: (account: Account) => void;
}) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<{ id: string; kind: "switch" | "logout" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 16, bottom: 70, width: 360, maxHeight: 480 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true), pending = useRef(false), latestState = useRef(state);
  latestState.current = state;
  const id = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect(), width = Math.min(360, innerWidth - 24);
      const bottom = Math.max(12, innerHeight - rect.top + 10);
      setPosition({ left: Math.max(12, Math.min(rect.left, innerWidth - width - 12)), bottom: Math.min(bottom, innerHeight - 200), width, maxHeight: Math.max(140, innerHeight - bottom - 60) });
    };
    place();
    const current = panel.current?.querySelector<HTMLButtonElement>('[data-current="true"]:not(:disabled)');
    (current ?? closeButton.current)?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false);
    };
    window.addEventListener("pointerdown", outside); window.addEventListener("focusin", outside); window.addEventListener("resize", place);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("focusin", outside); window.removeEventListener("resize", place); };
  }, [open]);
  const navigate = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    const target = event.target as HTMLElement;
    if (!target.hasAttribute("data-account-id") || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const buttons = [...panel.current!.querySelectorAll<HTMLButtonElement>('[data-account-id]:not(:disabled)')];
    const index = buttons.indexOf(target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next]?.focus();
  };
  const perform = async (kind: "switch" | "logout", account: Account) => {
    if (pending.current || (kind === "switch" && account.active)) return;
    // Move keyboard focus before disabling actions so Escape remains reachable.
    if (panel.current?.contains(document.activeElement)) closeButton.current?.focus({ preventScroll: true });
    pending.current = true; setAction({ id: account.id, kind }); setError(null); setNotice(null);
    const originalId = state.activeAccount?.id;
    const finishTransition = beginAccountTransition();
    try {
      await window.mados.invoke(kind === "switch" ? "auth.switchAccount" : "auth.logout", { accountId: account.id });
      const next = await window.mados.invoke<LauncherState>("app.getState");
      if (!mounted.current) return;
      // A separate account change must not be overwritten by an older state response.
      const currentId = latestState.current.activeAccount?.id;
      if (currentId !== originalId && currentId !== next.activeAccount?.id) return;
      onStateChange(next);
      setNotice(kind === "switch" ? `Выбран аккаунт ${next.activeAccount?.username ?? "Mados"}` : "Вы вышли из аккаунта");
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : "Не удалось выполнить действие. Попробуйте ещё раз."); }
    finally { finishTransition(); pending.current = false; if (mounted.current) setAction(null); }
  };
  const select = (account: Account) => {
    if (pending.current) return;
    if (account.status === "expired") { close(false); onReauthenticate(account); return; }
    void perform("switch", account);
  };
  const active = state.activeAccount;
  return <div className="account-wrap">
    <button ref={trigger} className="account-button" aria-label="Аккаунты" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
      <span className="account-avatar account-initials" aria-hidden="true">{initials(active?.username)}</span>
      <span className="account-copy"><strong>{active?.username ?? "Аккаунт"}</strong><small className={active?.status === "available" ? "" : "account-status-muted"}>{status(active)}</small></span><ChevronDown size={15} className={open ? "rotated" : ""} />
    </button>
    {open && createPortal(<section ref={panel} id={id} role="dialog" aria-label="Ваши аккаунты" className="account-panel" style={position} onKeyDown={navigate}>
      <header className="account-panel-heading"><div><span className="eyebrow">Ваше пространство</span><h2>Аккаунты</h2></div><button ref={closeButton} className="icon-button" aria-label="Закрыть аккаунты" data-tooltip="Закрыть" onClick={() => close()}><X size={17} /></button></header>
      <div className="account-panel-identity" key={active?.id}><span className="account-identity-avatar" aria-hidden="true">{initials(active?.username)}</span><div><strong data-tooltip={active?.username ?? undefined}>{active?.username ?? "Аккаунт"}</strong><span><ShieldCheck size={13} />{status(active)}</span></div></div>
      <div className="account-panel-label">Сохранённые аккаунты <span>{state.accounts.length}</span></div>
      <div className="account-panel-list">{state.accounts.map(account => {
        const waiting = action?.id === account.id, expired = account.status === "expired";
        return <button key={account.id} data-account-id={account.id} data-current={account.active} className={`account-panel-option ${account.active ? "selected" : ""} ${expired ? "expired" : ""}`} disabled={Boolean(action)} aria-label={`${account.username ?? "Аккаунт"}: ${expired ? "Войти снова" : account.active ? "Активный аккаунт" : "Переключиться"}`} onClick={() => select(account)}>
          <span className="account-list-avatar" aria-hidden="true">{initials(account.username)}</span><span className="account-option-copy"><strong>{account.username ?? "Аккаунт"}</strong><small>{waiting ? action.kind === "logout" ? "Выходим…" : "Переключаем…" : status(account)}</small></span>
          <span className="account-option-action">{waiting ? <LoaderCircle size={17} className="spin" /> : expired ? <><span>Войти снова</span><LogIn size={16} /></> : account.active ? <Check size={17} className="account-selected-check" /> : <ArrowRight size={17} />}</span>
        </button>;
      })}</div>
      <div className="account-panel-feedback" aria-live="polite">{error && <p role="alert">{error}</p>}{notice && !error && <p className="account-success"><Check size={14} />{notice}</p>}</div>
      <footer className="account-panel-footer"><button className="secondary-button" data-action="add-account" disabled={Boolean(action)} onClick={() => { close(false); onAddAccount(); }}><Plus size={16} />Добавить аккаунт</button>{active && <button className="ghost-button danger-text" data-action="logout" disabled={Boolean(action)} onClick={() => void perform("logout", active)}><LogOut size={16} />Выйти из текущего</button>}</footer>
    </section>, document.body)}
  </div>;
}
