import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

type Option = { value: string; label: string };
export function SelectField({ value, options, onChange, label, placeholder = "Выберите", disabled, icon, className = "" }: {
  value: string; options: Option[]; onChange: (value: string) => void; label: string; placeholder?: string;
  disabled?: boolean; icon?: ReactNode; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 180, maxHeight: 260 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = options.findIndex(option => option.value === value);
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const below = innerHeight - rect.bottom - 14;
      const height = Math.min(260, options.length * 40 + 12, Math.max(below, rect.top - 14));
      const width = Math.min(Math.max(rect.width, 180), innerWidth - 24);
      setPosition({ top: below >= height ? rect.bottom + 6 : Math.max(12, rect.top - height - 6), left: Math.max(12, Math.min(rect.left, innerWidth - width - 12)), width, maxHeight: height });
    };
    place();
    menu.current?.querySelectorAll<HTMLButtonElement>("button")[Math.max(selected, 0)]?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, options.length, selected]);
  const navigate = (event: KeyboardEvent) => {
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>("button")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "Tab") close();
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus();
    } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); buttons[current]?.click(); }
  };
  return <>
    <button ref={trigger} id={`${id}-trigger`} type="button" className={`mados-select-trigger ${className}`} disabled={disabled || options.length === 0} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)} onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); } }}>{icon}<span>{options[selected]?.label ?? placeholder}</span><ChevronDown size={15} className={open ? "rotated" : ""} /></button>
    {open && createPortal(<div ref={menu} id={id} className="mados-select-menu" role="listbox" aria-label={label} style={position} onKeyDown={navigate}>{options.map(option => <button type="button" role="option" aria-selected={option.value === value} key={option.value} onClick={() => { close(); onChange(option.value); }}><span>{option.label}</span>{option.value === value && <Check size={15} />}</button>)}</div>, document.body)}
  </>;
}
