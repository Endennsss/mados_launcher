import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, MouseEvent, ReactNode, SetStateAction } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Download,
  ExternalLink,
  Gamepad2,
  Globe2,
  Heart,
  Home,
  Languages,
  LoaderCircle,
  LogIn,
  LogOut,
  Maximize2,
  Menu,
  Minimize2,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  TerminalSquare,
  TimerReset,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import type {
  Account,
  ConnectionProgress,
  Favorite,
  LauncherState,
  NewsItem,
  PlaytimePeriod,
  PlaytimeSummary,
  Server,
  ServerDetails,
  ServerListResult,
  Settings as LauncherSettings,
  WorkerEvent,
} from "../contracts/launcher";
import catLogo from "./assets/cat-logo.png";

type Tab = "home" | "servers" | "news" | "playtime" | "settings";
type ThemeId = "mados" | "violet" | "ocean" | "emerald" | "amber";
type RequestError = Error & { code?: string; details?: { errors?: string[] } };
type ShellUpdate = { status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error"; version?: string; percent?: number; message?: string };

const themeOptions: Array<{ id: ThemeId; label: string; swatch: string }> = [
  { id: "mados", label: "Mados", swatch: "#ff1f2d" },
  { id: "violet", label: "Фиолетовая", swatch: "#a855f7" },
  { id: "ocean", label: "Океан", swatch: "#3b82f6" },
  { id: "emerald", label: "Изумрудная", swatch: "#10b981" },
  { id: "amber", label: "Янтарная", swatch: "#f59e0b" },
];

function storedTheme(): ThemeId {
  const value = localStorage.getItem("mados.theme");
  return themeOptions.some((option) => option.id === value) ? value as ThemeId : "mados";
}

const tabs: Array<{ id: Tab; label: string; icon: typeof Home }> = [
  { id: "home", label: "Главная", icon: Home },
  { id: "servers", label: "Серверы", icon: Globe2 },
  { id: "news", label: "Новости", icon: Newspaper },
  { id: "playtime", label: "Время игры", icon: Clock3 },
  { id: "settings", label: "Настройки", icon: Settings },
];

export function App() {
  const [state, setState] = useState<LauncherState | null>(null);
  const [settings, setSettings] = useState<LauncherSettings | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [startupError, setStartupError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionProgress | null>(null);
  const [shellUpdate, setShellUpdate] = useState<ShellUpdate>({ status: "idle" });
  const [online, setOnline] = useState(navigator.onLine);
  const [dragActive, setDragActive] = useState(false);
  const [accountLoginOpen, setAccountLoginOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(storedTheme);

  useEffect(() => {
    const language = settings?.language?.toLowerCase();
    document.documentElement.lang = language?.startsWith("en") ? "en" : "ru";
    document.documentElement.classList.toggle("reduce-motion", localStorage.getItem("mados.reducedMotion") === "true");
  }, [settings]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("mados.theme", theme);
  }, [theme]);

  useEffect(() => {
    const unsubscribe = window.mados.onEvent((event) => handleWorkerEvent(event, setState, setConnection, setStartupError, setShellUpdate));
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    const onLauncherError = (event: Event) => setStartupError((event as CustomEvent<{ message: string }>).detail.message);
    const onDragOver = (event: DragEvent) => { event.preventDefault(); setDragActive(true); };
    const onDragLeave = (event: DragEvent) => { if (event.target === event.currentTarget) setDragActive(false); };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragActive(false);
      const file = event.dataTransfer?.files[0];
      if (!file) return;
      const path = window.mados.getPathForFile(file);
      if (!path.toLowerCase().endsWith(".zip")) {
        setStartupError("Можно открыть только .zip контент-бандл или реплей.");
        return;
      }
      void window.mados.invoke("content.openBundle", { path }).catch((error: Error) => setStartupError(error.message));
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("launcher-error", onLauncherError);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    void Promise.all([
      window.mados.invoke<LauncherState>("app.getState"),
      window.mados.invoke<LauncherSettings>("settings.get"),
    ]).then(([nextState, nextSettings]) => {
      setState(nextState);
      setSettings(nextSettings);
    }).catch((error: RequestError) => setStartupError(error.message));

    return () => {
      unsubscribe();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("launcher-error", onLauncherError);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  if (startupError && !state) {
    return <FatalError message={startupError} onRetry={() => window.location.reload()} />;
  }

  if (!state) {
    return <LoadingScreen />;
  }

  if (!state.loggedIn || state.activeAccount?.status === "expired") {
    return <LoginScreen onLoggedIn={setState} expired={state.activeAccount?.status === "expired"} />;
  }

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-layout">
        <Sidebar state={state} tab={tab} setTab={setTab} onStateChange={setState} onAddAccount={() => setAccountLoginOpen(true)} />
        <main className="main-content">
          <div className="content-scroll">
            <div className="global-status-stack">
              {!online && <div className="offline-banner"><AlertTriangle size={16} /> Нет соединения с интернетом. Кэшированные данные остаются доступны.</div>}
              {state.compatibility && <CompatibilityBanner state={state} onStateChange={setState} />}
              {startupError && <InlineError message={startupError} onClose={() => setStartupError(null)} />}
              {connection && <ConnectionBanner progress={connection} onCancel={() => void window.mados.invoke("connection.cancel")} />}
              {shellUpdate.status !== "idle" && <ShellUpdateBanner update={shellUpdate} setUpdate={setShellUpdate} />}
            </div>
            {tab === "home" && <HomeView state={state} onNavigate={setTab} onStateChange={setState} />}
            {tab === "servers" && <ServersView state={state} onStateChange={setState} />}
            {tab === "news" && <NewsView settings={settings} />}
            {tab === "playtime" && <PlaytimeView state={state} onNavigate={setTab} />}
            {tab === "settings" && <SettingsView settings={settings} setSettings={setSettings} theme={theme} setTheme={setTheme} />}
          </div>
        </main>
      </div>
      {dragActive && <div className="drop-overlay"><div className="drop-card"><Download size={28} /><strong>Отпустите .zip здесь</strong><span>Контент-бандл или реплей откроется через C# worker</span></div></div>}
      {accountLoginOpen && <LoginScreen mode="add" onLoggedIn={(next) => { setState(next); setAccountLoginOpen(false); }} onCancel={() => setAccountLoginOpen(false)} />}
    </div>
  );
}

function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const listener = (event: Event) => setMaximized((event as CustomEvent<{ maximized: boolean }>).detail.maximized);
    window.addEventListener("window-state", listener);
    return () => window.removeEventListener("window-state", listener);
  }, []);
  return (
    <header className="title-bar">
      <div className="title-brand"><CatMark small /><span>Mados Launcher</span></div>
      <div className="window-controls">
        <button aria-label="Свернуть" onClick={() => window.mados.minimize()}><Minimize2 size={15} /></button>
        <button aria-label={maximized ? "Восстановить" : "Развернуть"} onClick={() => window.mados.toggleMaximize()}>{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
        <button aria-label="Закрыть" className="close-control" onClick={() => window.mados.close()}><X size={16} /></button>
      </div>
    </header>
  );
}

function Sidebar({ state, tab, setTab, onStateChange, onAddAccount }: { state: LauncherState; tab: Tab; setTab: (tab: Tab) => void; onStateChange: (state: LauncherState) => void; onAddAccount: () => void }) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("mados.sidebarCollapsed") === "true");
  const toggleCollapsed = () => setCollapsed((value) => {
    const next = !value;
    localStorage.setItem("mados.sidebarCollapsed", String(next));
    return next;
  });
  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="brand-block">
        <CatMark />
        <div><strong>Mados</strong><span>Launcher</span></div>
        <button className="sidebar-toggle" aria-label={collapsed ? "Развернуть панель" : "Свернуть панель"} title={collapsed ? "Развернуть панель" : "Свернуть панель"} onClick={toggleCollapsed}><span className="sidebar-toggle-glyph">{collapsed ? <PanelLeftOpen size={18} strokeWidth={2.1} /> : <PanelLeftClose size={18} strokeWidth={2.1} />}</span></button>
      </div>
      <nav className="side-nav" aria-label="Основная навигация">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} className={`nav-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
            <Icon className={`nav-icon ${id === "settings" ? "gear-icon" : ""} ${id === "playtime" ? "clock-icon" : ""}`} size={19} strokeWidth={1.9} /><span>{label}</span>{tab === id && <span className="active-dot" />}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="account-wrap">
          <button className="account-button" onClick={() => setAccountOpen((open) => !open)}>
            <span className="account-avatar"><UserRound size={16} /></span>
            <span className="account-copy"><strong>{state.activeAccount?.username ?? "Аккаунт"}</strong><small>В сети</small></span>
            <ChevronDown size={15} className={accountOpen ? "rotated" : ""} />
          </button>
          {accountOpen && <AccountMenu state={state} onStateChange={onStateChange} onAddAccount={() => { setAccountOpen(false); onAddAccount(); }} />}
        </div>
        <div className="sidebar-version">Mados Launcher · {state.version}</div>
      </div>
    </aside>
  );
}

function AccountMenu({ state, onStateChange, onAddAccount }: { state: LauncherState; onStateChange: (state: LauncherState) => void; onAddAccount: () => void }) {
  const [switching, setSwitching] = useState(false);
  const switchAccount = async (account: Account) => {
    setSwitching(true);
    try {
      const next = await window.mados.invoke<Account>("auth.switchAccount", { accountId: account.id });
      onStateChange({ ...state, activeAccount: next, accounts: state.accounts.map((item) => ({ ...item, active: item.id === account.id })), loggedIn: true });
    } finally { setSwitching(false); }
  };
  const logout = async () => {
    await window.mados.invoke("auth.logout", { accountId: state.activeAccount?.id });
    onStateChange(await window.mados.invoke<LauncherState>("app.getState"));
  };
  return (
    <div className="account-menu popover">
      <div className="popover-label">Аккаунты</div>
      {state.accounts.map((account) => <button key={account.id} className="account-option" disabled={switching} onClick={() => void switchAccount(account)}><span className={`status-dot ${account.status === "expired" ? "expired" : ""}`} />{account.username ?? "Аккаунт"}<Check size={14} className={account.active ? "visible" : "hidden"} /></button>)}
      <button className="account-option account-add" onClick={() => { onAddAccount(); }}><Plus size={15} />Добавить аккаунт</button>
      <div className="popover-divider" />
      <button className="account-option danger-text" onClick={() => void logout()}><LogOut size={15} />Выйти</button>
    </div>
  );
}

function HomeView({ state, onNavigate, onStateChange }: { state: LauncherState; onNavigate: (tab: Tab) => void; onStateChange: (state: LauncherState) => void }) {
  const [lastServer, setLastServer] = useState<Server | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedFavorite, setSelectedFavorite] = useState<Favorite | null>(null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  useEffect(() => {
    const stored = localStorage.getItem("mados.lastServer");
    if (stored) {
      try { setLastServer(JSON.parse(stored) as Server); } catch { localStorage.removeItem("mados.lastServer"); }
    }
  }, []);
  const connect = async (server: Server) => {
    setBusy(true);
    localStorage.setItem("mados.lastServer", JSON.stringify(server));
    setLastServer(server);
    try { await window.mados.invoke("servers.connect", { address: server.address, name: server.name }); } finally { setBusy(false); }
  };
  const removeFavorite = async (favorite: Favorite) => {
    setFavoriteError(null);
    try {
      const favorites = await window.mados.invoke<Favorite[]>("favorites.remove", { address: favorite.address });
      onStateChange({ ...state, favorites });
    } catch (caught) {
      setFavoriteError((caught as Error).message);
    }
  };
  return (
    <>
    <section className="page page-enter">
      <div className="page-heading"><div><p className="eyebrow">Добро пожаловать обратно</p><h1>{state.activeAccount?.username ?? "Mados"}</h1><p className="page-subtitle">Готовы вернуться на станцию?</p></div><div className="heading-actions"><button className="icon-button" aria-label="Справка"><CircleHelp size={18} /></button></div></div>
      <div className="hero-card">
        <div className="hero-glow" />
        <div className="hero-content"><div className="hero-icon"><Gamepad2 size={26} /></div><div><span className="eyebrow">Быстрый запуск</span><h2>{lastServer?.name ?? "Выберите сервер"}</h2><p>{lastServer ? `${lastServer.playerCount} игроков сейчас онлайн` : "Откройте каталог серверов, чтобы начать игру"}</p></div></div>
        <div className="hero-action">
          <button className="primary-button hero-button" disabled={busy} onClick={() => lastServer ? void connect(lastServer) : onNavigate("servers")}>{busy ? <LoaderCircle className="spin" size={18} /> : lastServer ? <Play className="play-icon" size={18} fill="currentColor" /> : <Globe2 size={18} />}{lastServer ? "Подключиться" : "Открыть серверы"}</button>
          {lastServer && <button className="hero-secondary" onClick={() => onNavigate("servers")}>Выбрать другой сервер <ArrowRight className="action-arrow" size={14} /></button>}
        </div>
      </div>
      <div className="section-heading"><div><h2>Избранные серверы</h2><span>{state.favorites.length} сохранено</span></div><button className="ghost-button" onClick={() => onNavigate("servers")}>Все серверы <ArrowRight className="action-arrow" size={15} /></button></div>
      {favoriteError && <InlineError message={favoriteError} onClose={() => setFavoriteError(null)} />}
      {state.favorites.length > 0 ? <div className="favorite-grid">{state.favorites.slice(0, 4).map((favorite) => <FavoriteCard key={favorite.address} favorite={favorite} onConnect={() => void connect(serverFromFavorite(favorite))} onRemove={() => void removeFavorite(favorite)} onDetails={() => setSelectedFavorite(favorite)} />)}</div> : <EmptyState icon={<Star size={23} />} title="Избранных серверов пока нет" description="Сохраните серверы, к которым возвращаетесь чаще всего." action="Открыть каталог" onAction={() => onNavigate("servers")} />}
      <div className="quick-actions"><button className="quick-action" onClick={() => onNavigate("servers")}><Globe2 size={18} /><span><strong>Каталог серверов</strong><small>Найти новую станцию</small></span><ArrowRight className="action-arrow" size={16} /></button><button className="quick-action" onClick={() => void openContentBundle()}><Download size={18} /><span><strong>Открыть контент-бандл</strong><small>Запустить .zip или реплей</small></span><ArrowRight className="action-arrow" size={16} /></button></div>
    </section>
    {selectedFavorite && <ServerDetailsModal server={serverFromFavorite(selectedFavorite)} onClose={() => setSelectedFavorite(null)} onConnect={() => { setSelectedFavorite(null); void connect(serverFromFavorite(selectedFavorite)); }} />}
    </>
  );
}

function serverFromFavorite(favorite: Favorite): Server {
  return { address: favorite.address, name: favorite.name, playerCount: 0, softMaxPlayerCount: 0, roundStartTime: null, runLevel: null, tags: [], status: "online", hubAddress: "" };
}

function FavoriteCard({ favorite, onConnect, onRemove, onDetails }: { favorite: Favorite; onConnect: () => void; onRemove: () => void; onDetails: () => void }) {
  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button,a,input")) return;
    onDetails();
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onDetails(); }
  };
  return <article className="favorite-card" role="button" tabIndex={0} aria-label={`Подробнее об избранном сервере ${favorite.name || favorite.address}`} onClick={handleCardClick} onKeyDown={handleKeyDown}><div className="favorite-card-top"><span className="server-status online" /><button className="favorite-star" aria-label="Удалить из избранного" onClick={(event) => { event.stopPropagation(); onRemove(); }}><Star size={16} fill="currentColor" /></button></div><h3>{favorite.name || "Без названия"}</h3><p>{favorite.address}</p><button className="card-connect" onClick={(event) => { event.stopPropagation(); onConnect(); }}>Подключиться <ArrowRight className="action-arrow" size={14} /></button></article>;
}

function ServersView({ state, onStateChange }: { state: LauncherState; onStateChange: (state: LauncherState) => void }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [onlyPopulated, setOnlyPopulated] = useState(false);
  const [selectedServer, setSelectedServer] = useState<Server | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("mados.serverFilters") ?? "[]") as string[]; } catch { return []; }
  });
  const [sort, setSort] = useState<"players" | "name">("players");
  const [directAddress, setDirectAddress] = useState("");

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const result = await window.mados.invoke<ServerListResult>("servers.list");
      setServers(result.servers);
      if (result.partialError) setError("Часть hub-серверов недоступна. Показаны доступные результаты.");
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim().toLowerCase()), 180);
    return () => window.clearTimeout(timer);
  }, [queryInput]);
  const filterOptions = useMemo(() => Array.from(new Set(servers.flatMap((server) => server.tags.filter((tag) => /^(lang:|region:|rp:|18\+|am_|as_|af_|eu_|oce|ind|me|luna|grl|ata)/i.test(tag))))).sort(), [servers]);
  const toggleTag = (tag: string) => setSelectedTags((current) => {
    const next = current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag];
    localStorage.setItem("mados.serverFilters", JSON.stringify(next));
    return next;
  });
  const filtered = useMemo(() => servers.filter((server) => {
    const matches = !query || `${server.name ?? ""} ${server.address}`.toLowerCase().includes(query);
    const tagsMatch = selectedTags.length === 0 || selectedTags.some((tag) => server.tags.includes(tag));
    return matches && tagsMatch && (!onlyPopulated || server.playerCount > 0);
  }).sort((a, b) => sort === "players" ? b.playerCount - a.playerCount : (a.name ?? a.address).localeCompare(b.name ?? b.address)), [servers, query, onlyPopulated, selectedTags, sort]);

  const connect = async (server: Server) => {
    localStorage.setItem("mados.lastServer", JSON.stringify(server));
    try { await window.mados.invoke("servers.connect", { address: server.address, name: server.name }); }
    catch (caught) { setError((caught as Error).message); }
  };
  const connectDirect = async () => {
    const address = directAddress.trim();
    if (!/^(ss14|ss14s):\/\//i.test(address)) { setError("Адрес должен начинаться с ss14:// или ss14s://"); return; }
    try {
      await window.mados.invoke("servers.connect", { address });
      localStorage.setItem("mados.lastServer", JSON.stringify({ address, name: "Прямое подключение", playerCount: 0, softMaxPlayerCount: 0, tags: [], status: "fetching", hubAddress: "" }));
      setDirectAddress("");
    } catch (caught) { setError((caught as Error).message); }
  };
  const toggleFavorite = async (server: Server) => {
    const exists = state.favorites.some((favorite) => favorite.address === server.address);
    const favorites = await window.mados.invoke<Favorite[]>(exists ? "favorites.remove" : "favorites.add", exists ? { address: server.address } : { address: server.address, name: server.name });
    onStateChange({ ...state, favorites });
  };

  return <>
    <section className="page page-enter">
    <div className="page-heading"><div><p className="eyebrow">Игровые миры</p><h1>Серверы</h1><p className="page-subtitle">Найдите станцию для следующей смены.</p></div><button className="icon-button" onClick={() => void load()} aria-label="Обновить"><RefreshCw size={18} className={loading ? "spin" : ""} /></button></div>
    <div className="toolbar"><label className="search-box"><Search size={17} /><input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="Поиск по названию или адресу" /></label><button className={`filter-button ${showFilters ? "active" : ""}`} onClick={() => setShowFilters((value) => !value)}><SlidersHorizontal size={16} /> Фильтры {(onlyPopulated || selectedTags.length > 0) && <span className="filter-count">{selectedTags.length + (onlyPopulated ? 1 : 0)}</span>}</button><select className="sort-select" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="players">По онлайну</option><option value="name">По названию</option></select></div>
    <div className="direct-connect"><TerminalSquare size={16} /><input value={directAddress} onChange={(event) => setDirectAddress(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void connectDirect(); }} placeholder="ss14://адрес — прямое подключение" /><button className="secondary-button" onClick={() => void connectDirect()} disabled={!directAddress.trim()}>Подключиться</button></div>
    {showFilters && <div className="filter-drawer"><div className="filter-drawer-head"><div><strong>Фильтры серверов</strong><span>Настройте каталог под себя</span></div>{(onlyPopulated || selectedTags.length > 0) && <button className="filter-reset" onClick={() => { setSelectedTags([]); setOnlyPopulated(false); localStorage.removeItem("mados.serverFilters"); }}>Сбросить</button>}</div><div className="filter-chip-list"><button className={`filter-chip ${onlyPopulated ? "selected" : ""}`} onClick={() => setOnlyPopulated((value) => !value)}><Users size={15} /> Только с игроками</button>{filterOptions.map((tag) => <button key={tag} className={`filter-chip ${selectedTags.includes(tag) ? "selected" : ""}`} onClick={() => toggleTag(tag)}>{formatFilterTag(tag)}</button>)}{filterOptions.length === 0 && <span className="filter-hint">Фильтры появятся после загрузки тегов серверов.</span>}</div></div>}
    {error && <InlineError message={error} onClose={() => setError(null)} />}
    {loading && servers.length === 0 ? <div className="server-grid">{Array.from({ length: 6 }, (_, index) => <div className="server-skeleton" key={index}><span /><span /><span /></div>)}</div> : filtered.length > 0 ? <div className="server-grid">{filtered.map((server) => <ServerCard key={server.address} server={server} favorite={state.favorites.some((favorite) => favorite.address === server.address)} onConnect={() => void connect(server)} onFavorite={() => void toggleFavorite(server)} onDetails={() => setSelectedServer(server)} />)}</div> : <EmptyState icon={<Search size={23} />} title="Ничего не найдено" description="Измените запрос или сбросьте фильтры." action="Сбросить фильтры" onAction={() => { setQueryInput(""); setSelectedTags([]); setOnlyPopulated(false); localStorage.removeItem("mados.serverFilters"); }} />}
    </section>
    {selectedServer && <ServerDetailsModal server={selectedServer} onClose={() => setSelectedServer(null)} onConnect={() => { setSelectedServer(null); void connect(selectedServer); }} />}
  </>;
}

function ServerCard({ server, favorite, onConnect, onFavorite, onDetails }: { server: Server; favorite: boolean; onConnect: () => void; onFavorite: () => void; onDetails: () => void }) {
  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button,a,input")) return;
    onDetails();
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onDetails(); }
  };
  return <article className="server-card" role="button" tabIndex={0} aria-label={`Подробнее о сервере ${server.name || server.address}`} onClick={handleCardClick} onKeyDown={handleKeyDown}><div className="server-card-head"><span className={`server-status ${server.status === "online" ? "online" : "offline"}`} /><span className="server-status-label">{server.status === "online" ? "Онлайн" : "Недоступен"}</span><button className={`star-button ${favorite ? "selected" : ""}`} onClick={(event) => { event.stopPropagation(); onFavorite(); }} aria-label={favorite ? "Удалить из избранного" : "Добавить в избранное"}><Star size={17} fill={favorite ? "currentColor" : "none"} /></button></div><h3>{server.name || "Без названия"}</h3><p className="server-address">{server.address}</p><div className="server-meta"><span><Users size={14} /> {server.playerCount}{server.softMaxPlayerCount > 0 ? ` / ${server.softMaxPlayerCount}` : ""}</span><span><Activity size={14} /> {server.pingMs == null ? "—" : `${server.pingMs} ms`}</span><span><Globe2 size={14} /> {server.language || "—"}</span></div>{server.map && <div className="server-map">Карта: {server.map}</div>}<div className="tag-row">{server.tags.slice(0, 3).map((tag) => <span className="tag" key={tag}>{formatFilterTag(tag)}</span>)}</div><button className="primary-button full-button" disabled={server.status !== "online"} onClick={(event) => { event.stopPropagation(); onConnect(); }}><Play className="play-icon" size={16} fill="currentColor" /> Подключиться</button></article>;
}

const filterLanguageNames: Record<string, string> = { ru: "Русский", en: "English", de: "Deutsch", es: "Español", fr: "Français", pl: "Polski", pt: "Português", uk: "Українська" };
const filterRegionNames: Record<string, string> = { am_n_c: "Северная Америка · центр", am_n_e: "Северная Америка · восток", am_n_w: "Северная Америка · запад", am_s_e: "Южная Америка · восток", am_s_s: "Южная Америка · юг", am_s_w: "Южная Америка · запад", eu: "Европа", eu_e: "Европа · восток", eu_w: "Европа · запад", as_e: "Азия · восток", as_n: "Азия · север", as_se: "Азия · юго-восток", af_c: "Африка · центр", oce: "Океания", ind: "Индия" };

function formatFilterTag(tag: string): string {
  const language = /^lang:(.+)$/i.exec(tag);
  if (language) return filterLanguageNames[language[1].toLowerCase()] ?? `Язык · ${language[1].toUpperCase()}`;
  const region = /^region:(.+)$/i.exec(tag);
  if (region) return filterRegionNames[region[1].toLowerCase()] ?? `Регион · ${region[1].toUpperCase()}`;
  const rolePlay = /^rp:(.+)$/i.exec(tag);
  if (rolePlay) return `RP · ${rolePlay[1] === "none" ? "нет" : rolePlay[1]}`;
  const eighteen = /^18\+:(true|false)$/i.exec(tag);
  if (eighteen) return eighteen[1].toLowerCase() === "true" ? "18+" : "Без 18+";
  if (/^18\+$/i.test(tag)) return "18+";
  return tag.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ServerDetailsModal({ server, onClose, onConnect }: { server: Server; onClose: () => void; onConnect: () => void }) {
  const [details, setDetails] = useState<ServerDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.mados.invoke<ServerDetails>("servers.info", { address: server.address, hubAddress: server.hubAddress }).then((result) => {
      if (!cancelled) setDetails(result);
    }).catch((caught: Error) => {
      if (!cancelled) setError(caught.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [server]);
  return <div className="modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="server-details-modal" role="dialog" aria-modal="true" aria-labelledby="server-details-title"><div className="modal-header"><div><p className="eyebrow">Информация о сервере</p><h2 id="server-details-title">{server.name || "Без названия"}</h2></div><button className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={18} /></button></div><div className="server-details-status"><span className={`server-status ${server.status === "online" ? "online" : "offline"}`} />{server.status === "online" ? "Онлайн" : "Недоступен"}<span>·</span><span>{server.playerCount}{server.softMaxPlayerCount > 0 ? ` / ${server.softMaxPlayerCount}` : ""} игроков</span><span>·</span><span>{server.pingMs == null ? "—" : `${server.pingMs} ms`}</span></div><p className="server-details-address">{server.address}</p>{loading ? <div className="details-loading"><LoaderCircle className="spin" size={20} /> Загружаем описание сервера…</div> : error ? <div className="details-error"><AlertTriangle size={17} /><span>{error}</span></div> : <div className="server-details-body"><p>{details?.description?.trim() || "Создатели сервера пока не добавили описание."}</p>{details?.links && details.links.length > 0 && <div className="server-link-list">{details.links.map((link) => <button className="text-link" key={link.url} onClick={() => void window.mados.openExternal(link.url)}>{link.name || link.url}<ExternalLink className="external-link" size={14} /></button>)}</div>}</div>}<div className="modal-actions"><button className="secondary-button" onClick={onClose}>Закрыть</button><button className="primary-button" disabled={server.status !== "online"} onClick={onConnect}><Play className="play-icon" size={16} fill="currentColor" /> Подключиться</button></div></section></div>;
}

function NewsView({ settings }: { settings: LauncherSettings | null }) {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = async () => { setLoading(true); setError(null); try { setItems(await window.mados.invoke<NewsItem[]>("news.list")); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);
  return <section className="page page-enter"><div className="page-heading"><div><p className="eyebrow">Последние обновления</p><h1>Новости</h1><p className="page-subtitle">События Space Station 14 и релизы Mados Launcher с GitHub.</p></div><button className="icon-button" onClick={() => void load()} aria-label="Обновить"><RefreshCw size={18} className={loading ? "spin" : ""} /></button></div>{error && <InlineError message={error} onClose={() => setError(null)} />}{loading ? <div className="news-list">{Array.from({ length: 3 }, (_, index) => <div className="news-skeleton" key={index} />)}</div> : <div className="news-list">{items.map((item, index) => <article className="news-card" key={`${item.link}-${index}`}><div className="news-icon"><Newspaper size={18} /></div><div className="news-copy"><span className="eyebrow">{item.source ?? "Space Station 14"}{item.date ? ` · ${new Date(item.date).toLocaleDateString()}` : ""}</span><h3>{item.title}</h3>{item.summary && <p className="news-summary">{item.summary}</p>}<button className="text-link" onClick={() => void window.mados.openExternal(item.link)}>Открыть публикацию <ExternalLink className="external-link" size={14} /></button></div></article>)}{items.length === 0 && <EmptyState icon={<Newspaper size={23} />} title="Новостей пока нет" description="Попробуйте обновить ленту позже." action="Повторить" onAction={() => void load()} />}</div>}</section>;
}

function PlaytimeView({ state, onNavigate }: { state: LauncherState; onNavigate: (tab: Tab) => void }) {
  const [period, setPeriod] = useState<PlaytimePeriod>("all");
  const [summary, setSummary] = useState<PlaytimeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setRefreshing(true);
    setError(null);
    try {
      setSummary(await window.mados.invoke<PlaytimeSummary>("playtime.getSummary", { period }));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period]);

  useEffect(() => { void load(true); }, [load, state.activeAccount?.id]);

  useEffect(() => {
    const unsubscribe = window.mados.onEvent((event) => {
      if (event.event === "playtime.updated" || event.event === "auth.changed") void load();
    });
    return unsubscribe;
  }, [load]);

  useEffect(() => {
    if (!summary?.activeSession) return;
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [summary?.activeSession]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const active = summary?.activeSession;
  const activeSeconds = active ? Math.max(active.elapsedSeconds, Math.floor((clock - new Date(active.startedAt).getTime()) / 1000)) : 0;
  const clearHistory = async () => {
    if (!window.confirm("Удалить накопленное время текущего аккаунта? Текущая игровая сессия продолжит считаться.")) return;
    setClearing(true);
    setError(null);
    try {
      const result = await window.mados.invoke<{ removed: number }>("playtime.clear");
      setNotice(result.removed > 0 ? `История очищена: удалено сессий — ${result.removed}.` : "Завершённых сессий для удаления не найдено.");
      await load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setClearing(false);
    }
  };

  return <section className="page page-enter playtime-page">
    <div className="page-heading"><div><p className="eyebrow">Личная статистика</p><h1>Время игры</h1><p className="page-subtitle">Сколько времени вы провели на разных серверах.</p></div><div className="heading-actions"><button className="icon-button" onClick={() => void load()} disabled={refreshing} aria-label="Обновить статистику" title="Обновить статистику"><RefreshCw size={18} className={refreshing ? "refresh-once" : ""} /></button><button className="icon-button playtime-clear-button" onClick={() => void clearHistory()} disabled={clearing || !summary || summary.sessionCount === 0} aria-label="Удалить историю" title="Удалить историю"><Trash2 size={18} /></button></div></div>
    <div className="playtime-periods" role="tablist" aria-label="Период статистики"><CalendarDays size={15} className="muted-icon" />{(["all", "today", "sevenDays"] as PlaytimePeriod[]).map((item) => <button key={item} role="tab" aria-selected={period === item} className={period === item ? "active" : ""} onClick={() => setPeriod(item)}>{playtimePeriodLabel(item)}</button>)}</div>
    {error && <InlineError message={error} onClose={() => setError(null)} />}
    {notice && <div className="inline-success"><Check size={16} /><span>{notice}</span></div>}
    {loading ? <div className="playtime-summary-grid">{Array.from({ length: 3 }, (_, index) => <div className="playtime-skeleton" key={index} />)}</div> : summary && <>
      <div className="playtime-summary-grid"><PlaytimeStat icon={<Clock3 size={19} />} label="Общее время" value={formatPlaytimeDuration(summary.totalSeconds)} /><PlaytimeStat icon={<Activity size={19} />} label="Сессии" value={String(summary.sessionCount)} /><PlaytimeStat icon={<Globe2 size={19} />} label="Серверы" value={String(summary.uniqueServers)} /></div>
      {active && <div className="playtime-active-card"><div className="playtime-active-icon"><TimerReset size={22} /></div><div className="playtime-active-copy"><span className="eyebrow">Сейчас играете</span><h2>{active.name || active.address}</h2><p>{active.address}</p></div><strong className="playtime-live-value">{formatPlaytimeDuration(activeSeconds)}</strong></div>}
      <div className="section-heading"><div><h2>Серверы</h2><span>{summary.trackedSince ? `Учёт с ${formatPlaytimeDate(summary.trackedSince)}` : "Учёт начнётся после первой игры"}</span></div></div>
      {summary.servers.length === 0 ? <EmptyState icon={<Clock3 size={23} />} title="Истории пока нет" description="Запустите сервер, и Mados Launcher начнёт считать реальное время игры." action="Открыть серверы" onAction={() => onNavigate("servers")} /> : <div className="playtime-server-grid">{summary.servers.map((server, index) => <article className={`playtime-server-card ${server.active ? "active" : ""}`} style={{ "--playtime-delay": `${index * 35}ms` } as CSSProperties} key={server.address}><div className="playtime-server-top"><span className={`server-status ${server.active ? "online" : "offline"}`} /><span>{server.active ? "Сейчас играете" : "Сервер"}</span><Clock3 size={15} className="playtime-card-icon" /></div><h3>{server.name || server.address}</h3><p>{server.address}</p><div className="playtime-server-value">{formatPlaytimeDuration(server.totalSeconds)}</div><div className="playtime-card-meta"><span>{server.sessionCount} {pluralize(server.sessionCount, "сессия", "сессии", "сессий")}</span><span>{server.lastPlayedAt ? `Последний запуск ${formatPlaytimeDate(server.lastPlayedAt)}` : "Нет завершённых запусков"}</span></div></article>)}</div>}
    </>}
  </section>;
}

function PlaytimeStat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="playtime-stat"><span className="playtime-stat-icon">{icon}</span><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function playtimePeriodLabel(period: PlaytimePeriod): string {
  return period === "today" ? "Сегодня" : period === "sevenDays" ? "7 дней" : "Всё время";
}

function formatPlaytimeDuration(seconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  if (totalMinutes < 1) return "меньше минуты";
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} д ${hours} ч ${minutes} мин`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

function formatPlaytimeDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function pluralize(value: number, one: string, few: string, many: string): string {
  const mod10 = value % 10;
  const mod100 = value % 100;
  return mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? few : many;
}

function SettingsView({ settings, setSettings, theme, setTheme }: { settings: LauncherSettings | null; setSettings: (settings: LauncherSettings) => void; theme: ThemeId; setTheme: (theme: ThemeId) => void }) {
  const [saving, setSaving] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => localStorage.getItem("mados.reducedMotion") === "true");
  const [section, setSection] = useState<"account" | "appearance" | "compatibility" | "diagnostics">("account");
  if (!settings) return <LoadingScreen />;
  const update = async (patch: Partial<LauncherSettings>) => { setSaving(true); try { setSettings(await window.mados.invoke<LauncherSettings>("settings.update", patch)); } finally { setSaving(false); } };
  const navItems: Array<{ id: typeof section; label: string; icon: typeof UserRound }> = [
    { id: "account", label: "Аккаунт", icon: UserRound },
    { id: "appearance", label: "Внешний вид", icon: Sparkles },
    { id: "compatibility", label: "Совместимость", icon: ShieldCheck },
    { id: "diagnostics", label: "Диагностика", icon: TerminalSquare },
  ];
  return <section className="page page-enter"><div className="page-heading"><div><p className="eyebrow">Персонализация</p><h1>Настройки</h1><p className="page-subtitle">Управляйте аккаунтом и поведением лаунчера.</p></div>{saving && <LoaderCircle className="spin muted-icon" size={19} />}</div><div className="settings-layout"><div className="settings-nav">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={`settings-nav-item ${section === id ? "active" : ""}`} onClick={() => setSection(id)}><Icon className="settings-nav-icon" size={16} /> {label}</button>)}</div><div className="settings-panels">{section === "account" && <SettingsGroup title="Аккаунт" icon={<UserRound size={18} />}><SettingRow title="Текущий аккаунт" description={"Активная сессия Mados Launcher"}><span className="setting-value"><span className="status-dot" />Активен</span></SettingRow><SettingRow title="Управление аккаунтом" description="Открыть настройки учётной записи на официальном сайте"><button className="secondary-button" onClick={() => void window.mados.openExternal(settings.accountManagementUrl)}>Открыть <ExternalLink className="external-link" size={14} /></button></SettingRow></SettingsGroup>}{section === "appearance" && <SettingsGroup title="Внешний вид" icon={<Sparkles size={18} />}><SettingRow title="Цветовая тема" description="Меняет только акцентные цвета интерфейса"><ThemePicker value={theme} onChange={setTheme} /></SettingRow><SettingRow title="Уменьшить движение" description="Отключить переходы и анимации интерфейса"><Toggle checked={reducedMotion} onChange={(checked) => { setReducedMotion(checked); localStorage.setItem("mados.reducedMotion", String(checked)); document.documentElement.classList.toggle("reduce-motion", checked); }} /></SettingRow><SettingRow title="Язык интерфейса" description="Русский и English доступны в текущей версии"><LanguageSelect value={settings.language ?? "auto"} onChange={(value) => void update({ language: value === "auto" ? null : value })} /></SettingRow></SettingsGroup>}{section === "compatibility" && <SettingsGroup title="Совместимость" icon={<ShieldCheck size={18} />}><SettingRow title="Compatibility mode" description="Использовать безопасные графические параметры"><Toggle checked={settings.compatMode} onChange={(checked) => void update({ compatMode: checked })} /></SettingRow><SettingRow title="Seasonal assets" description="Разрешить загрузку официальных override-ассетов"><Toggle checked={settings.overrideAssets} onChange={(checked) => void update({ overrideAssets: checked })} /></SettingRow></SettingsGroup>}{section === "diagnostics" && <SettingsGroup title="Диагностика" icon={<TerminalSquare size={18} />}><SettingRow title="Подробное логирование" description="Нужно для разбора сложных проблем запуска"><Toggle checked={settings.verboseLogging} onChange={(checked) => void update({ verboseLogging: checked })} /></SettingRow><SettingRow title="Версия" description="Mados Launcher"><span className="setting-value">{(window as Window & { __madosVersion?: string }).__madosVersion ?? "0.40.1"}</span></SettingRow></SettingsGroup>}</div></div></section>;
}

function SettingsGroup({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) { return <section className="settings-group"><div className="settings-group-title"><span className="settings-group-icon">{icon}</span><h2>{title}</h2></div><div className="settings-rows">{children}</div></section>; }
function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) { return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div>{children}</div>; }
function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) { return <button className={`toggle ${checked ? "checked" : ""}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>; }

function ThemePicker({ value, onChange }: { value: ThemeId; onChange: (theme: ThemeId) => void }) {
  return <div className="theme-picker" role="radiogroup" aria-label="Цветовая тема">{themeOptions.map((option) => <button type="button" key={option.id} className={`theme-option ${value === option.id ? "selected" : ""}`} aria-checked={value === option.id} role="radio" title={option.label} onClick={() => onChange(option.id)}><span className="theme-swatch" style={{ background: option.swatch } as CSSProperties} /><span>{option.label}</span></button>)}</div>;
}

function LanguageSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const options = [{ value: "auto", label: "Системный" }, { value: "ru", label: "Русский" }, { value: "en-US", label: "English" }];
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const current = options.find((option) => option.value === value) ?? options[0];
  return <div className="custom-select" ref={rootRef}><button className="custom-select-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((state) => !state)}><Languages size={15} /><span>{current.label}</span><ChevronDown size={15} className={open ? "rotated" : ""} /></button>{open && <div className="custom-select-menu" role="listbox">{options.map((option) => <button key={option.value} role="option" aria-selected={option.value === value} className={`custom-select-option ${option.value === value ? "selected" : ""}`} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}{option.value === value && <Check size={14} />}</button>)}</div>}</div>;
}

function LoginScreen({ onLoggedIn, expired = false, mode = "login", onCancel }: { onLoggedIn: (state: LauncherState) => void; expired?: boolean; mode?: "login" | "add"; onCancel?: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tfaCode, setTfaCode] = useState("");
  const [requiresTfa, setRequiresTfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { await window.mados.invoke("auth.login", { username, password, ...(requiresTfa ? { tfaCode } : {}) }); const next = await window.mados.invoke<LauncherState>("app.getState"); onLoggedIn(next); } catch (caught) { const requestError = caught as RequestError; if (requestError.code === "TFAREQUIRED" || requestError.code === "TFA_REQUIRED") setRequiresTfa(true); setError(requestError.details?.errors?.join("\n") ?? requestError.message); } finally { setBusy(false); } };
  return <div className={`login-screen ${mode === "add" ? "login-overlay" : ""}`}><div className="login-backdrop" /><div className="login-panel">{mode === "add" && onCancel && <button className="icon-button login-close" onClick={onCancel} aria-label="Закрыть"><X size={18} /></button>}<div className="login-logo"><CatMark large /><span>Mados Launcher</span></div><div className="login-copy"><p className="eyebrow">{mode === "add" ? "Новый профиль" : "Добро пожаловать"}</p><h1>{mode === "add" ? "Добавить аккаунт" : expired ? "Сессия истекла" : "Войдите в аккаунт"}</h1><p>{mode === "add" ? "Добавьте ещё один аккаунт и переключайтесь между профилями из боковой панели." : expired ? "Войдите снова, чтобы продолжить игру." : "Продолжите игру на своей станции."}</p></div><form onSubmit={submit} className="login-form"><label>Имя пользователя<input autoFocus value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label><label>Пароль<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>{requiresTfa && <label>Код 2FA<input inputMode="numeric" value={tfaCode} onChange={(event) => setTfaCode(event.target.value)} autoComplete="one-time-code" required /></label>}{error && <div className="form-error"><AlertTriangle size={16} /><span>{error}</span></div>}<button className="primary-button login-submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <LogIn size={18} />} {requiresTfa ? "Подтвердить вход" : mode === "add" ? "Добавить аккаунт" : "Войти"}</button></form><div className="login-links"><button onClick={() => void window.mados.openExternal("https://account.spacestation14.com/Identity/Account/Register")}>Создать аккаунт <ExternalLink size={13} /></button><button onClick={() => void window.mados.openExternal("https://account.spacestation14.com/Identity/Account/ForgotPassword")}>Забыли пароль?</button></div>{mode === "add" && onCancel && <button className="login-cancel" onClick={onCancel}>Отмена</button>}<div className="security-note"><ShieldCheck size={15} /> Данные входа обрабатываются защищённым C# worker</div></div></div>;
}

function CatMark({ small = false, large = false }: { small?: boolean; large?: boolean }) {
  return <span className={`brand-avatar ${small ? "small-mark" : ""} ${large ? "large" : ""}`}><img src={catLogo} alt="" /></span>;
}

function CompatibilityBanner({ state, onStateChange }: { state: LauncherState; onStateChange: (state: LauncherState) => void }) {
  const compatibility = state.compatibility;
  if (!compatibility) return null;
  const dismiss = async (key: "dismissEarlyAccess" | "dismissIntelDegradation" | "dismissRosetta") => {
    await window.mados.invoke("settings.update", { [key]: true });
    onStateChange({ ...state, compatibility: { ...compatibility, ...(key === "dismissEarlyAccess" ? { earlyAccess: false } : {}), ...(key === "dismissIntelDegradation" ? { intelDegradation: false } : {}), ...(key === "dismissRosetta" ? { rosetta: false } : {}) } });
  };
  if (compatibility.outOfDate) return <div className="compatibility-banner warning"><AlertTriangle size={17} /><div><strong>Версия лаунчера устарела</strong><span>Обновление требуется для безопасного запуска.</span></div><button className="secondary-button" onClick={() => void window.mados.openExternal("https://spacestation14.com/about/nightlies/")}>Скачать</button></div>;
  const item = compatibility.authOverride ? { title: "Auth override включён", description: "Используется тестовый сервер авторизации.", action: undefined } : compatibility.intelDegradation ? { title: "Проверьте процессор Intel", description: "13/14-е поколения могут быть нестабильны при запуске игры.", action: "dismissIntelDegradation" as const } : compatibility.rosetta ? { title: "Запуск через Rosetta", description: "Доступна нативная сборка для Apple Silicon.", action: "dismissRosetta" as const } : compatibility.earlyAccess ? { title: "Space Station 14 — ранний доступ", description: "Некоторые функции игры ещё меняются.", action: "dismissEarlyAccess" as const } : null;
  if (!item) return null;
  return <div className="compatibility-banner"><AlertTriangle size={17} /><div><strong>{item.title}</strong><span>{item.description}</span></div>{item.action && <button className="ghost-button" onClick={() => void dismiss(item.action)}>Больше не показывать</button>}</div>;
}

function ConnectionBanner({ progress, onCancel }: { progress: ConnectionProgress; onCancel: () => void }) {
  const policy = progress.privacyPolicy;
  const awaitingPolicy = progress.status === "AwaitingPrivacyPolicyAcceptance" && policy;
  const downloadProgress = getDownloadProgress(progress.progress);
  return <div className="connection-banner">
    <div className="connection-spinner"><LoaderCircle size={18} className={awaitingPolicy ? "" : "spin"} /></div>
    <div className="connection-copy">
      <strong>{awaitingPolicy ? "Политика конфиденциальности сервера" : connectionLabel(progress.status)}</strong>
      <small>{awaitingPolicy ? <>Перед подключением ознакомьтесь с <button className="text-link inline-link" onClick={() => void window.mados.openExternal(policy.link)}>политикой сервера</button>.</> : progress.reason || "Подготовка подключения к серверу"}</small>
      {!awaitingPolicy && <div className={`connection-progress-track ${downloadProgress == null ? "indeterminate" : ""}`} aria-label={downloadProgress == null ? "Выполняется подключение" : `Загрузка ${downloadProgress}%`}><span style={downloadProgress == null ? undefined : { width: `${downloadProgress}%` }} /></div>}
    </div>
    {awaitingPolicy ? <div className="connection-actions"><button className="ghost-button" onClick={() => void window.mados.invoke("connection.confirmPrivacyPolicy", { accepted: false })}>Отклонить</button><button className="primary-button compact-button" onClick={() => void window.mados.invoke("connection.confirmPrivacyPolicy", { accepted: true })}>Принять</button></div> : <button className="ghost-button" onClick={onCancel}>Отменить</button>}
  </div>;
}

function getDownloadProgress(progress: ConnectionProgress["progress"]): number | null {
  if (!progress || typeof progress !== "object") return null;
  const downloaded = typeof progress.downloaded === "number" ? progress.downloaded : 0;
  const total = typeof progress.total === "number" ? progress.total : 0;
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(downloaded / total * 100)));
}
function ShellUpdateBanner({ update, setUpdate }: { update: ShellUpdate; setUpdate: (update: ShellUpdate) => void }) {
  if (update.status === "checking" || update.status === "downloading") return <div className="connection-banner"><LoaderCircle size={17} className="spin" /><span>{update.status === "checking" ? "Проверяем обновления Mados Launcher…" : `Скачиваем обновление… ${Math.round(update.percent ?? 0)}%`}</span></div>;
  if (update.status === "available") return <div className="connection-banner"><Download size={17} /><span>Доступна новая версия {update.version ?? "Mados Launcher"}</span><button className="primary-button compact-button" onClick={async () => { setUpdate({ ...update, status: "downloading", percent: 0 }); await window.mados.downloadUpdate(); }}>Скачать</button><button className="ghost-button" onClick={() => setUpdate({ status: "idle" })}>Позже</button></div>;
  if (update.status === "downloaded") return <div className="connection-banner"><Check size={17} /><span>Обновление готово к установке.</span><button className="primary-button compact-button" onClick={() => window.mados.installUpdate()}>Перезапустить</button></div>;
  if (update.status === "error") return <InlineError message={update.message ?? "Не удалось проверить обновления"} onClose={() => setUpdate({ status: "idle" })} />;
  return null;
}
function connectionLabel(status: string) { const labels: Record<string, string> = { Connecting: "Подключение…", Updating: "Загрузка игрового контента…", StartingClient: "Запуск игры…", AwaitingPrivacyPolicyAcceptance: "Ожидается подтверждение политики…", ClientRunning: "Игра запущена", ClientExited: "Игра завершена", Cancelled: "Подключение отменено", ConnectionFailed: "Не удалось подключиться" }; return labels[status] ?? status; }
function EmptyState({ icon, title, description, action, onAction }: { icon: React.ReactNode; title: string; description: string; action: string; onAction: () => void }) { return <div className="empty-state"><div className="empty-icon">{icon}</div><h2>{title}</h2><p>{description}</p><button className="secondary-button" onClick={onAction}>{action} <ArrowRight className="action-arrow" size={14} /></button></div>; }
function InlineError({ message, onClose }: { message: string; onClose: () => void }) { return <div className="inline-error"><AlertTriangle size={16} /><span>{message}</span><button onClick={onClose} aria-label="Закрыть"><X size={15} /></button></div>; }
function FatalError({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="fatal-screen"><div className="fatal-icon"><AlertTriangle size={28} /></div><h1>Mados Launcher не запустился</h1><p>{message}</p><button className="primary-button" onClick={onRetry}><RefreshCw size={17} /> Повторить</button></div>; }
function LoadingScreen() { return <div className="loading-screen"><CatMark large /><LoaderCircle size={22} className="spin" /><span>Запуск Mados Launcher…</span></div>; }
async function openContentBundle() { const path = await window.mados.pickContentBundle(); if (path) await window.mados.invoke("content.openBundle", { path }); }

function handleWorkerEvent(event: WorkerEvent, setState: Dispatch<SetStateAction<LauncherState | null>>, setConnection: Dispatch<SetStateAction<ConnectionProgress | null>>, setStartupError: Dispatch<SetStateAction<string | null>>, setShellUpdate: Dispatch<SetStateAction<ShellUpdate>>) {
  if (event.event === "app.ready") setState(event.data as LauncherState);
  if (event.event === "auth.changed") { const data = event.data as { accounts: Account[]; activeAccount: Account | null }; setState((current) => ({ ...(current as LauncherState), accounts: data.accounts, activeAccount: data.activeAccount, loggedIn: data.activeAccount != null })); }
  if (event.event === "connection.progress") setConnection(event.data as ConnectionProgress);
  if (event.event === "connection.completed") setConnection(null);
  if (event.event === "connection.failed") {
    setConnection(null);
    const data = event.data as { message?: string; status?: string };
    setStartupError(data.message ?? `Подключение завершилось состоянием ${data.status ?? "ошибка"}`);
  }
  if (event.event === "update.progress") {
    const data = event.data as { status?: string; progress?: ConnectionProgress["progress"] };
    setConnection({ status: data.status ?? "Updating", progress: data.progress });
  }
  if (event.event === "update.completed") setConnection(null);
  if (event.event === "app.error") setStartupError("Worker initialization failed");
  if (event.event === "shell.updateChecking") setShellUpdate({ status: "checking" });
  if (event.event === "shell.updateAvailable") setShellUpdate({ status: "available", version: (event.data as { version?: string }).version });
  if (event.event === "shell.updateNotAvailable") setShellUpdate({ status: "idle" });
  if (event.event === "shell.updateProgress") setShellUpdate({ status: "downloading", percent: (event.data as { percent?: number }).percent });
  if (event.event === "shell.updateDownloaded") setShellUpdate({ status: "downloaded", version: (event.data as { version?: string }).version });
  if (event.event === "shell.updateError") setShellUpdate({ status: "error", message: (event.data as { message?: string }).message });
}
