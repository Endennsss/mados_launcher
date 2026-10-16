import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Gamepad2, Globe2, Home, Play, RotateCcw, Settings, Undo2 } from "lucide-react";

export const themeOptions = [
  { id: "mados", label: "Mados", description: "Фирменный красный" },
  { id: "violet", label: "Фиолетовая", description: "Глубокий аметист" },
  { id: "ocean", label: "Океан", description: "Холодный синий" },
  { id: "emerald", label: "Изумрудная", description: "Спокойный зелёный" },
  { id: "amber", label: "Янтарная", description: "Тёплый золотой" },
] as const;
export type ThemeId = typeof themeOptions[number]["id"];
type ThemeSelection = { theme: ThemeId; previous: ThemeId | null };
export function useLauncherTheme() {
  const [selection, setSelection] = useState<ThemeSelection>(() => {
    try { const stored = localStorage.getItem("mados.theme"); return { theme: themeOptions.find(option => option.id === stored)?.id ?? "mados", previous: null }; }
    catch { return { theme: "mados", previous: null }; }
  });
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => { document.documentElement.dataset.theme = selection.theme; }, [selection.theme]);
  useEffect(() => {
    try { localStorage.setItem("mados.theme", selection.theme); setError(null); }
    catch { setError("Тема применена, но не сохранилась. После перезапуска может вернуться прежнее оформление."); }
  }, [selection.theme]);
  return {
    value: selection.theme, canUndo: selection.previous !== null, error,
    onChange: (next: ThemeId) => setSelection(current => current.theme === next ? current : { theme: next, previous: current.theme }),
    onUndo: () => setSelection(current => current.previous ? { theme: current.previous, previous: null } : current),
  };
}

export function ThemePicker({ value, onChange, onUndo, canUndo, error }: {
  value: ThemeId; onChange: (theme: ThemeId) => void; onUndo: () => void; canUndo: boolean; error: string | null;
}) {
  const choices = useRef<HTMLDivElement>(null);
  const navigate = (event: KeyboardEvent, index: number) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? themeOptions.length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + themeOptions.length) % themeOptions.length;
    onChange(themeOptions[next].id); choices.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus({ preventScroll: true });
  };
  return <div className="theme-studio">
    <div className="theme-studio-heading"><div><h3>Цветовая тема</h3><p>Ваш привычный Mados в другом цвете. Выберите оформление — оно применится сразу.</p></div></div>
    <div ref={choices} className="theme-preview-grid" role="radiogroup" aria-label="Цветовая тема">{themeOptions.map((option, index) => <button type="button" key={option.id} role="radio" aria-checked={value === option.id} aria-label={option.label} tabIndex={value === option.id ? 0 : -1} data-theme-choice={option.id} className={`theme-preview-choice ${value === option.id ? "selected" : ""}`} onClick={() => onChange(option.id)} onKeyDown={event => navigate(event, index)}>
      <span className="theme-preview" data-theme={option.id} aria-hidden="true"><span className="theme-mini-title"><span className="theme-mini-brand" />Mados<span className="theme-mini-controls">···</span></span><span className="theme-mini-body"><span className="theme-mini-sidebar"><Home size={11} /><Globe2 size={11} /><Settings size={11} /></span><span className="theme-mini-content"><span className="theme-mini-line heading" /><span className="theme-mini-hero"><Gamepad2 size={21} /><span><i /><i /></span><span className="theme-mini-play"><Play size={8} /></span></span><span className="theme-mini-cards"><i /><i /></span></span></span></span>
      <span className="theme-choice-footer"><span><strong>{option.label}</strong><small>{option.description}</small></span><span className="theme-choice-check" aria-hidden="true">{value === option.id && <Check key={value} size={16} />}</span></span>
    </button>)}</div>
    <div className="theme-studio-footer"><span role="status">Текущая тема: <strong>{themeOptions.find(option => option.id === value)?.label}</strong></span><div><button className="ghost-button" data-action="undo-theme" disabled={!canUndo} onClick={onUndo}><Undo2 size={15} />Отменить изменение</button><button className="secondary-button compact-button" data-action="reset-theme" disabled={value === "mados"} onClick={() => onChange("mados")}><RotateCcw size={15} />Вернуть Mados</button></div></div>
    {error && <p className="theme-storage-error" role="alert">{error}</p>}
  </div>;
}
