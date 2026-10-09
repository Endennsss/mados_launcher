import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { Activity, Clock3, Command, CornerDownLeft, Globe2, Home, Newspaper, Play, RefreshCw, Search, ServerCog, Settings } from "lucide-react";
import type { LaunchProfile } from "./launch-profiles";
import type { LauncherState } from "../contracts/launcher";

export type CommandPaletteTab = "home" | "servers" | "news" | "playtime" | "tools" | "settings";

export type CommandAction =
  | { type: "navigate"; tab: CommandPaletteTab }
  | { type: "connect-last" }
  | { type: "connect-profile"; profileId: string }
  | { type: "refresh-servers" }
  | { type: "open-monitoring" };

export type CommandPaletteItem = {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  icon?: LucideIcon;
  action: CommandAction;
  disabled?: boolean;
};

export type CommandPaletteContext = {
  profiles?: LaunchProfile[];
  hasLastServer?: boolean;
};

export type CommandPaletteProps = {
  /** Optional when the parent conditionally renders the palette. */
  open?: boolean;
  commands?: CommandPaletteItem[];
  /** Compatibility props for the shell's simple navigation integration. */
  state?: LauncherState | null;
  profiles?: LaunchProfile[];
  hasLastServer?: boolean;
  onClose: () => void;
  onExecute?: (action: CommandAction) => void;
  onNavigate?: (tab: CommandPaletteTab) => void;
};

/** Builds the stable built-in command set; dynamic profile commands are appended last. */
export function buildCommandPaletteCommands(context: CommandPaletteContext = {}): CommandPaletteItem[] {
  const commands: CommandPaletteItem[] = [
    { id: "navigate-home", label: "Открыть главную", description: "Перейти на главный экран", keywords: ["главная", "home"], icon: Home, action: { type: "navigate", tab: "home" } },
    { id: "navigate-servers", label: "Открыть серверы", description: "Перейти в каталог серверов", keywords: ["серверы", "servers", "каталог"], icon: Globe2, action: { type: "navigate", tab: "servers" } },
    { id: "navigate-news", label: "Открыть новости", description: "Посмотреть новости лаунчера", keywords: ["новости", "news"], icon: Newspaper, action: { type: "navigate", tab: "news" } },
    { id: "navigate-playtime", label: "Открыть время игры", description: "Посмотреть статистику по серверам", keywords: ["время", "игра", "playtime"], icon: Clock3, action: { type: "navigate", tab: "playtime" } },
    { id: "navigate-tools", label: "Открыть инструменты", description: "Импортировать и запустить локальный сервер", keywords: ["инструменты", "локальный", "cdn", "сервер"], icon: ServerCog, action: { type: "navigate", tab: "tools" } },
    { id: "navigate-settings", label: "Открыть настройки", description: "Настроить внешний вид и поведение", keywords: ["настройки", "settings"], icon: Settings, action: { type: "navigate", tab: "settings" } },
    { id: "refresh-servers", label: "Обновить каталог серверов", description: "Загрузить актуальные данные", keywords: ["обновить", "refresh", "ping"], icon: RefreshCw, action: { type: "refresh-servers" } },
    { id: "open-monitoring", label: "Открыть мониторинг избранного", description: "Показать ping и онлайн избранных серверов", keywords: ["мониторинг", "избранное", "online"], icon: Activity, action: { type: "open-monitoring" } },
  ];
  if (context.hasLastServer) {
    commands.splice(5, 0, { id: "connect-last", label: "Запустить последний сервер", description: "Подключиться к последнему серверу", keywords: ["запустить", "последний", "играть"], action: { type: "connect-last" } });
  }
  for (const profile of context.profiles ?? []) {
    commands.push({ id: `connect-profile:${profile.id}`, label: `Запустить ${profile.name}`, description: profile.address, keywords: ["профиль", "запустить", profile.name, profile.address], icon: Play, action: { type: "connect-profile", profileId: profile.id } });
  }
  return commands;
}

/** Case-insensitive token matching with a stable score for exact/prefix matches. */
export function filterCommandPaletteCommands(commands: CommandPaletteItem[], query: string): CommandPaletteItem[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return commands.filter((command) => !command.disabled);
  return commands
    .map((command, index) => {
      if (command.disabled) return { command, score: -1, index };
      const haystack = [command.label, command.description ?? "", ...(command.keywords ?? [])].join(" ").toLocaleLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) return { command, score: -1, index };
      const label = command.label.toLocaleLowerCase();
      const score = tokens.reduce((total, token) => total + (label === token ? 10 : label.startsWith(token) ? 5 : haystack.indexOf(token) >= 0 ? 1 : 0), 0);
      return { command, score, index };
    })
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ command }) => command);
}

export function useCommandPaletteShortcut(onOpen: () => void, disabled = false): void {
  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled, onOpen]);
}

export function CommandPalette({ open = true, commands: providedCommands, profiles, hasLastServer, onClose, onExecute, onNavigate }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = useMemo(() => providedCommands ?? buildCommandPaletteCommands({ profiles, hasLastServer }), [hasLastServer, profiles, providedCommands]);
  const visibleCommands = useMemo(() => filterCommandPaletteCommands(commands, query), [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(visibleCommands.length - 1, 0)));
  }, [visibleCommands.length]);

  if (!open) return null;

  const execute = (action: CommandAction) => {
    if (onExecute) {
      onExecute(action);
    } else if (action.type === "navigate" && onNavigate) {
      onNavigate(action.tab);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => visibleCommands.length === 0 ? 0 : (current + 1) % visibleCommands.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => visibleCommands.length === 0 ? 0 : (current - 1 + visibleCommands.length) % visibleCommands.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = visibleCommands[selectedIndex];
      if (command) {
        execute(command.action);
        onClose();
      }
    }
  };

  return <div className="command-palette-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="command-palette" role="dialog" aria-modal="true" aria-label="Командная палитра"><div className="command-palette-search"><Search size={17} /><input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }} onKeyDown={handleKeyDown} placeholder="Найти действие или профиль" aria-label="Поиск команды" /><kbd>Ctrl K</kbd></div><div className="command-palette-list" role="listbox" aria-label="Команды">{visibleCommands.map((command, index) => { const Icon = command.icon ?? Command; return <button type="button" key={command.id} className={`command-palette-item ${index === selectedIndex ? "selected" : ""}`} role="option" aria-selected={index === selectedIndex} onMouseEnter={() => setSelectedIndex(index)} onClick={() => { execute(command.action); onClose(); }}><Icon size={17} /><span><strong>{command.label}</strong>{command.description && <small>{command.description}</small>}</span><CornerDownLeft size={14} className="command-palette-enter" /></button>; })}{visibleCommands.length === 0 && <p className="command-palette-empty">Ничего не найдено</p>}</div></section></div>;
}
