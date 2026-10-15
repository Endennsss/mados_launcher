import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

export type MenuAction = {
  id: string; label: string; icon?: ReactNode; disabled?: boolean; danger?: boolean; separator?: boolean;
  onSelect: () => unknown | Promise<unknown>;
};

export function ActionMenu({ label, items, disabled, onError }: {
  label: string; items: MenuAction[]; disabled?: boolean; onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 228, maxHeight: 320 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!open || disabled) { if (open) setOpen(false); return; }
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.min(228, innerWidth - 24);
      const below = innerHeight - rect.bottom - 14;
      const popup = menu.current!;
      const height = Math.min(popup.scrollHeight + popup.offsetHeight - popup.clientHeight, Math.max(below, rect.top - 14));
      setPosition({ left: Math.max(12, Math.min(rect.right - width, innerWidth - width - 12)), top: below >= height ? rect.bottom + 6 : Math.max(12, rect.top - height - 6), width, maxHeight: height });
    };
    place(); menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const outside = (event: Event) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false); };
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) place(); };
    window.addEventListener("pointerdown", outside); window.addEventListener("focusin", outside); window.addEventListener("resize", place); window.addEventListener("scroll", scroll, true);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("focusin", outside); window.removeEventListener("resize", place); window.removeEventListener("scroll", scroll, true); };
  }, [open, disabled, items.length]);
  const navigate = (event: KeyboardEvent) => {
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "Tab") close();
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus();
    } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); buttons[current]?.click(); }
  };
  const choose = async (item: MenuAction) => {
    close();
    try { await item.onSelect(); } catch (caught) { onError(caught instanceof Error ? caught.message : "Не удалось выполнить действие"); }
  };
  return <>
    <button ref={trigger} type="button" className="secondary-button action-menu-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}><MoreHorizontal size={17} />Ещё</button>
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label={label} className="mados-action-menu" style={position} onKeyDown={navigate}>{items.map(item => <button key={item.id} type="button" role="menuitem" disabled={item.disabled} className={`${item.danger ? "danger-text" : ""} ${item.separator ? "menu-separated" : ""}`} onClick={() => void choose(item)}>{item.icon}<span>{item.label}</span></button>)}</div>, document.body)}
  </>;
}
