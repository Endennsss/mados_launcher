import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { Activity, ArrowRight, Clock3, Command, CornerDownLeft, Globe2, Home, LoaderCircle, Newspaper, Play, RefreshCw, Search, ServerCog, Settings, X } from "lucide-react";
import type { LaunchProfile } from "./launch-profiles";
import type { Favorite, LauncherState, Server } from "../contracts/launcher";
import { sanitizeServerAddress } from "./ui-helpers";
import { normalizeSearch, searchableSettings, settingsSections, type SettingId } from "./settings-search";

export type CommandPaletteTab = "home" | "servers" | "news" | "playtime" | "tools" | "settings";

export type CommandAction =
  | { type: "navigate"; tab: CommandPaletteTab }
  | { type: "connect-last" }
  | { type: "connect-profile"; profileId: string }
  | { type: "open-server"; server: Server }
  | { type: "open-setting"; settingId: SettingId }
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
  group?: "actions" | "favorites" | "servers" | "profiles" | "settings";
};

export type CommandPaletteContext = {
  profiles?: LaunchProfile[];
  hasLastServer?: boolean;
  servers?: Server[];
  favorites?: Favorite[];
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
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
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
  for (const command of commands) command.group = command.action.type === "connect-profile" ? "profiles" : "actions";
  const servers = new Map<string, Server>();
  for (const server of context.servers ?? []) {
    const address = sanitizeServerAddress(server.address);
    if (address) servers.set(address, { ...server, address });
  }
  const favorites = new Map((context.favorites ?? []).map(item => [sanitizeServerAddress(item.address), item]));
  for (const [address, favorite] of favorites) {
    if (address && !servers.has(address)) servers.set(address, { address, name: favorite.name, playerCount: 0, softMaxPlayerCount: 0, status: "unknown", tags: [], hubAddress: "", roundStartTime: null, runLevel: null });
  }
  for (const [address, server] of servers) {
    const favorite = favorites.get(address);
    commands.push({ id: `server:${address}`, label: server.name || address.replace(/^ss14s?:\/\//, ""), description: address, keywords: [favorite?.name ?? "", server.map ?? "", server.mode ?? "", ...server.tags], icon: Globe2, group: favorite ? "favorites" : "servers", action: { type: "open-server", server } });
  }
  for (const setting of searchableSettings) {
    const section = settingsSections.find(item => item.id === setting.section)!;
    commands.push({ id: `setting:${setting.id}`, label: setting.title, description: setting.description, keywords: [section.label, ...setting.keywords], group: "settings", icon: setting.icon, action: { type: "open-setting", settingId: setting.id } });
  }
  return commands;
}

/** Case-insensitive token matching with a stable score for exact/prefix matches. */
export function filterCommandPaletteCommands(commands: CommandPaletteItem[], query: string): CommandPaletteItem[] {
  const tokens = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return commands.filter((command) => !command.disabled);
  return commands
    .map((command, index) => {
      if (command.disabled) return { command, score: -1, index };
      const haystack = normalizeSearch([command.label, command.description ?? "", ...(command.keywords ?? [])].join(" "));
      if (!tokens.every((token) => haystack.includes(token))) return { command, score: -1, index };
      const label = normalizeSearch(command.label);
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

const groups = [
  ["actions", "Действия"], ["favorites", "Избранное"], ["profiles", "Профили запуска"], ["servers", "Серверы"], ["settings", "Настройки"],
] as const;

export function CommandPalette({ open = true, commands: providedCommands, profiles, hasLastServer, onClose, onExecute, onNavigate, loading, error, onRetry }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const selection = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({top:0,height:0});
  const executed = useRef(false);
  const listId = useId();
  const commands = useMemo(() => providedCommands ?? buildCommandPaletteCommands({ profiles, hasLastServer }), [hasLastServer, profiles, providedCommands]);
  const matches = useMemo(() => filterCommandPaletteCommands(commands, query), [commands, query]);
  const sections = useMemo(() => groups.map(([id, label]) => ({ id, label, items: matches.filter(item => (item.group ?? "actions") === id).slice(0, 20) })), [matches]);
  const visibleCommands = useMemo(() => sections.flatMap(section => section.items), [sections]);
  const selected = visibleCommands.find(item => item.id === selectedId) ?? visibleCommands[0];
  const selectedIndex = selected ? visibleCommands.indexOf(selected) : -1;
  const optionId = (item: CommandPaletteItem) => `${listId}-${encodeURIComponent(item.id)}`;

  useLayoutEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedId(null);
    executed.current = false;
    const previous = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root"), wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    inputRef.current?.focus();
    return () => {
      if (root) root.inert = wasInert;
      if (!executed.current && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    selection.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected?.id]);
  useLayoutEffect(() => {
    const measure=()=>{const element=selection.current;setIndicator({top:element?.offsetTop ?? 0,height:element?.offsetHeight ?? 0});};
    measure();
    if(typeof ResizeObserver === "undefined" || !list.current)return;
    const observer=new ResizeObserver(measure);observer.observe(list.current);return()=>observer.disconnect();
  },[selected?.id,visibleCommands]);

  if (!open) return null;

  const execute = (action: CommandAction) => {
    executed.current = true;
    if (onExecute) {
      onExecute(action);
    } else if (action.type === "navigate" && onNavigate) {
      onNavigate(action.tab);
    }
    onClose();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Tab") {
      const focusable = [...dialog.current!.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"]):not(:disabled)')];
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
    } else if (event.target !== inputRef.current) return;
    else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const length = visibleCommands.length;
      const index = event.key === "Home" ? 0 : event.key === "End" ? length - 1 : (selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + length) % length;
      setSelectedId(visibleCommands[index]?.id ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!event.nativeEvent.isComposing && selected) execute(selected.action);
    }
  };

  return createPortal(<div className="command-palette-overlay mados-search-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className="command-palette mados-search" role="dialog" aria-modal="true" aria-label="Поиск по лаунчеру" onKeyDown={handleKeyDown}>
      <header className="search-heading"><span><Command size={15}/> Поиск Mados</span><button className="icon-button" aria-label="Закрыть поиск" onClick={onClose}><X size={17}/></button></header>
      <div className="command-palette-search"><Search size={21}/><input ref={inputRef} value={query} onChange={event => { setQuery(event.target.value); setSelectedId(null); }} placeholder="Сервер, профиль или настройка…" aria-label="Поиск по лаунчеру" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={selected ? optionId(selected) : undefined}/><kbd>Ctrl K</kbd></div>
      {(loading || error) && <div className="search-source-status" role="status">{loading && <LoaderCircle size={14} className="spin"/>}<span>{error || "Загружаем серверы и профили…"}</span>{error && onRetry && <button onClick={onRetry} disabled={loading}>Повторить <RefreshCw size={13}/></button>}</div>}
      <div className="search-body"><div ref={list} className="command-palette-list" id={listId} role="listbox" aria-label="Результаты поиска">
        {selected && <div aria-hidden="true" className="search-selection" style={{transform:`translateY(${indicator.top}px)`,height:indicator.height}}/>}
        {sections.filter(section => section.items.length).map(section => <div key={section.id} role="group" aria-label={section.label}><div className="search-group-label">{section.label}<span>{section.items.length}</span></div>{section.items.map(command => {
          const Icon = command.icon ?? Command, active = command.id === selected?.id;
          return <button type="button" tabIndex={-1} id={optionId(command)} ref={active ? selection : undefined} key={command.id} className={`command-palette-item ${active ? "selected" : ""}`} role="option" aria-selected={active} onMouseEnter={() => setSelectedId(command.id)} onClick={() => execute(command.action)}><span className="search-result-icon"><Icon size={18}/></span><span><strong><SearchMatch text={command.label} query={query}/></strong>{command.description && <small>{command.description}</small>}</span><CornerDownLeft size={14} className="command-palette-enter"/></button>;
        })}</div>)}
        {!visibleCommands.length && <div className="command-palette-empty"><Search size={27}/><strong>Ничего не найдено</strong><span>Попробуйте название сервера, адрес или слово «анимации».</span></div>}
      </div><SearchPreview key={selected?.id ?? "empty"} item={selected} execute={execute}/></div>
      <footer className="search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> выбрать <kbd>Enter</kbd> открыть</span><span aria-live="polite">{visibleCommands.length < matches.length ? `${visibleCommands.length} из ${matches.length} · уточните запрос` : `Найдено: ${matches.length}`}</span></footer>
    </section>
  </div>, document.body);
}

function SearchPreview({ item, execute }: { item?: CommandPaletteItem; execute: (action: CommandAction) => void }) {
  if (!item) return <aside className="search-preview search-preview-empty"><Command size={30}/><span>Всё нужное — в одном поиске</span></aside>;
  const Icon = item.icon ?? Command, server = item.action.type === "open-server" ? item.action.server : null;
  const label = item.action.type === "connect-profile" || item.action.type === "connect-last" ? "Запустить" : item.action.type === "open-server" ? "Описание сервера" : item.action.type === "open-setting" ? "К настройке" : "Выполнить";
  return <aside className="search-preview"><div className="search-preview-symbol"><Icon size={28}/></div><p className="eyebrow">{groups.find(([id]) => id === (item.group ?? "actions"))?.[1]}</p><h2>{item.label}</h2><p className="search-preview-description">{item.description}</p>
    {server && <dl className="search-server-facts"><div><dt>Статус</dt><dd>{server.status === "online" ? "Онлайн" : server.status === "offline" ? "Недоступен" : "Нет данных"}</dd></div><div><dt>Игроки</dt><dd>{server.status === "online" ? `${server.playerCount} / ${server.softMaxPlayerCount || "—"}` : "—"}</dd></div><div><dt>Ping</dt><dd>{server.pingMs == null ? "—" : `${server.pingMs} мс`}</dd></div><div><dt>Карта</dt><dd>{server.map || "Не указано"}</dd></div><div><dt>Режим</dt><dd>{server.mode || "Не указано"}</dd></div></dl>}
    <button className="primary-button" onClick={() => execute(item.action)}>{label}<ArrowRight size={16}/></button><small className="search-preview-hint">{server ? "Актуальные данные загрузятся в описании" : item.group === "settings" ? "Откроется нужный раздел и параметр" : "Доступно также по Enter"}</small>
  </aside>;
}

export function SearchMatch({ text, query }: { text: string; query: string }) {
  const tokens = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return <>{text}</>;
  const normalized = normalizeSearch(text), spans: Array<{start:number;end:number}> = [];
  for (const token of tokens) { let start = normalized.indexOf(token); while(start >= 0) { spans.push({start,end:start+token.length}); start=normalized.indexOf(token,start+token.length); } }
  spans.sort((a,b)=>a.start-b.start);
  const merged: typeof spans=[];for(const span of spans) { const last=merged.at(-1);if(last && span.start<=last.end)last.end=Math.max(last.end,span.end);else merged.push({...span}); }
  let offset=0;const parts=[];for(const span of merged){parts.push(text.slice(offset,span.start),<mark key={span.start}>{text.slice(span.start,span.end)}</mark>);offset=span.end;}parts.push(text.slice(offset));
  return <>{parts}</>;
}
