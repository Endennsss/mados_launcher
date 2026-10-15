import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, MouseEvent, ReactNode, SetStateAction } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  CheckCircle2,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Download,
  FileArchive,
  FolderOpen,
  Command,
  ExternalLink,
  Gamepad2,
  Globe2,
  Home,
  Languages,
  Link2,
  LoaderCircle,
  LogIn,
  LogOut,
  Maximize2,
  Minimize2,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  PackageOpen,
  Plus,
  RefreshCw,
  Radio,
  RotateCw,
  Search,
  Save,
  ServerCog,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  StickyNote,
  Square,
  Terminal,
  TerminalSquare,
  TimerReset,
  Trash2,
  Wifi,
  WifiOff,
  UserRound,
  Users,
  X,
} from "lucide-react";
import type {
  ShellUpdateState,
  Account,
  ConnectionProgress,
  DiscordPresenceStatus,
  Favorite,
  LauncherState,
  NewsItem,
  PlaytimePeriod,
  PlaytimeSummary,
  RecentConnection,
  Server,
  ServerListResult,
  Settings as LauncherSettings,
  StartupState,
  WorkerEvent,
  CdnInspection,
  CdnImportRequest,
  LocalServerConfig,
  LocalServerLogLine,
  LocalServerProfile,
  LocalServerSnapshot,
} from "../contracts/launcher";
import catLogo from "./assets/cat-logo.png";
import { sortRecentConnections } from "./recent-connections";
import { sanitizeServerAddress } from "./ui-helpers";
import { acceptCatalogSnapshot, catalogError } from "./server-catalog";
import {
  formatDelta,
  formatDurationSince,
  notificationTone,
  notificationUnreadCount,
  sparklinePoints,
} from "./monitoring";
import type { FavoriteMonitorSummary, FavoriteMonitoringFailure, LaunchProfile, LauncherNotification } from "../contracts/launcher";
import { CommandPalette, type CommandAction } from "./CommandPalette";
import { LaunchProfiles } from "./LaunchProfiles";
import type { LaunchProfileDraft } from "./launch-profiles";
import { ToolsView } from "./ToolsView";
import { LastServerCard } from "./LastServerCard";
import { ServerDetailsPanel } from "./ServerDetailsPanel";
import { LaunchDock } from "./LaunchDock";
import { LauncherUpdateView } from "./LauncherUpdateView";
import { reduceLaunchEvent, type LaunchActivity } from "./launch-status";

import { ConfirmProvider, useConfirm } from "./ConfirmDialog";
import { ServerMark } from "./ServerMark";
import { queueServerHandoff } from "./server-handoff";
import { TooltipLayer } from "./TooltipLayer";
import { SelectField } from "./SelectField";

type Tab = "home" | "servers" | "news" | "playtime" | "tools" | "settings";
type CatalogTool = "monitoring" | "profiles" | "direct";
type ThemeId = "mados" | "violet" | "ocean" | "emerald" | "amber";
type RequestError = Error & { code?: string; details?: { errors?: string[] } };
type ShellUpdate = ShellUpdateState;

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
  { id: "tools", label: "Инструменты", icon: ServerCog },
  { id: "settings", label: "Настройки", icon: Settings },
];

export function App() { return <ConfirmProvider><LauncherApp /><TooltipLayer /></ConfirmProvider>; }

function LauncherApp() {
  const [state, setState] = useState<LauncherState | null>(null);
  const confirm = useConfirm(state?.activeAccount?.id);
  const [settings, setSettings] = useState<LauncherSettings | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [catalogTool, setCatalogTool] = useState<CatalogTool | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupState, setStartupState] = useState<StartupState>({ stage: "starting-worker" });
  const [connection, setConnection] = useState<LaunchActivity | null>(null);
  const [shellUpdate, setShellUpdate] = useState<ShellUpdate>({ status: "idle", currentVersion: "—", revision: -1 });
  const [online, setOnline] = useState(navigator.onLine);
  const [dragActive, setDragActive] = useState(false);
  const [accountLoginOpen, setAccountLoginOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(storedTheme);
  const [discordStatus, setDiscordStatus] = useState<DiscordPresenceStatus>("unavailable");
  const [notifications, setNotifications] = useState<LauncherNotification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [toast, setToast] = useState<LauncherNotification | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [profiles, setProfiles] = useState<LaunchProfile[]>([]);
  const [profilesBusy, setProfilesBusy] = useState(false);

  const markNotificationRead = useCallback(async (notification: LauncherNotification) => {
    if (notification.readAt) return;
    try { await window.mados.notifications.markRead(notification.id); } catch { /* best effort */ }
    setNotifications((items) => items.map((item) => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item));
  }, []);

  const clearNotifications = useCallback(async () => {
    try { await window.mados.notifications.clear(); } catch { /* best effort */ }
    setNotifications([]);
    setNotificationsOpen(false);
  }, []);

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
    const startupApi = window.mados as typeof window.mados & { onStartupState?: (listener: (state: StartupState) => void) => () => void; getStartupState?: () => Promise<StartupState> };
    const unsubscribeStartup = startupApi.onStartupState?.((next) => setStartupState(next)) ?? (() => undefined);
    const startupPromise = startupApi.getStartupState?.();
    if (startupPromise) void startupPromise.then(setStartupState).catch(() => undefined);
    const unsubscribe = window.mados.onEvent((event) => handleWorkerEvent(event, setState, setSettings, setConnection, setStartupError, setShellUpdate));
    void window.mados.getUpdateState?.().then(next => setShellUpdate(current => next.revision >= current.revision ? next : current)).catch(() => undefined);
    const unsubscribeDiscord = window.mados.onDiscordStatus(({ status }) => setDiscordStatus(status));
    const unsubscribeNotifications = window.mados.onEvent((event) => {
      if (event.event !== "notification.created") return;
      const item = event.data as LauncherNotification;
      if (!item?.id) return;
      setNotifications((items) => [item, ...items.filter((existing) => existing.id !== item.id)].slice(0, 30));
      setToast(item);
      window.setTimeout(() => setToast((current) => current?.id === item.id ? null : current), 5200);
    });
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
      unsubscribeStartup();
      unsubscribeDiscord();
      unsubscribeNotifications();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("launcher-error", onLauncherError);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!state?.activeAccount?.id) {
      setNotifications([]);
      return () => { cancelled = true; };
    }
    void window.mados.notifications.list().then((items) => {
      if (!cancelled) setNotifications(Array.isArray(items) ? items : []);
    }).catch(() => {
      if (!cancelled) setNotifications([]);
    });
    return () => { cancelled = true; };
  }, [state?.activeAccount?.id]);

  const reloadProfiles = useCallback(async () => {
    if (!state?.activeAccount?.id) {
      setProfiles([]);
      return;
    }
    try {
      const items = await window.mados.launchProfiles.list();
      setProfiles(Array.isArray(items) ? items : []);
    } catch {
      setProfiles([]);
    }
  }, [state?.activeAccount?.id]);

  useEffect(() => {
    void reloadProfiles();
    const unsubscribe = window.mados.onEvent((event) => {
      if (event.event === "launchProfiles.updated") void reloadProfiles();
    });
    return unsubscribe;
  }, [reloadProfiles]);

  const createProfile = useCallback(async (draft: LaunchProfileDraft) => {
    setProfilesBusy(true);
    try {
      const created = await window.mados.launchProfiles.create(draft.name, draft.address);
      setProfiles((items) => [created, ...items.filter((item) => item.id !== created.id && item.address !== created.address)]);
    } catch (caught) {
      setStartupError((caught as Error).message);
    } finally {
      setProfilesBusy(false);
    }
  }, []);

  const updateProfile = useCallback(async (id: string, draft: LaunchProfileDraft) => {
    setProfilesBusy(true);
    try {
      const updated = await window.mados.launchProfiles.update(id, draft.name, draft.address);
      setProfiles((items) => [updated, ...items.filter((item) => item.id !== id && item.address !== updated.address)]);
    } catch (caught) {
      setStartupError((caught as Error).message);
    } finally {
      setProfilesBusy(false);
    }
  }, []);

  const removeProfile = useCallback(async (profile: LaunchProfile) => {
    if (!await confirm({ title: "Удалить профиль?", message: `Профиль «${profile.name}» исчезнет из быстрых действий. Игровые файлы сохранятся.`, confirmLabel: "Удалить", destructive: true })) return;
    setProfilesBusy(true);
    try {
      await window.mados.launchProfiles.remove(profile.id);
      setProfiles((items) => items.filter((item) => item.id !== profile.id));
    } catch (caught) {
      setStartupError((caught as Error).message);
    } finally {
      setProfilesBusy(false);
    }
  }, []);

  const useProfile = useCallback(async (profile: LaunchProfile) => {
    setProfilesBusy(true);
    try {
      const selected = await window.mados.launchProfiles.use(profile.id);
      setProfiles((items) => items.map((item) => item.id === selected.id ? selected : item));
      await window.mados.invoke("servers.connect", { address: selected.address, name: selected.name });
    } catch (caught) {
      setStartupError((caught as Error).message);
    } finally {
      setProfilesBusy(false);
    }
  }, []);

  const executePaletteAction = useCallback(async (action: CommandAction) => {
    if (action.type === "navigate") {
      setTab(action.tab);
      return;
    }
    if (action.type === "refresh-servers") {
      setTab("servers");
      window.dispatchEvent(new CustomEvent("servers-refresh-requested"));
      return;
    }
    if (action.type === "open-monitoring") {
      setTab("servers");
      setCatalogTool("monitoring");
      return;
    }
    if (action.type === "connect-profile") {
      const profile = profiles.find((item) => item.id === action.profileId);
      if (profile) await useProfile(profile);
      return;
    }
    if (action.type === "connect-last") {
      const stored = localStorage.getItem(lastServerStorageKey(state?.activeAccount?.id));
      if (!stored) return;
      try {
        const server = JSON.parse(stored) as Server;
        await window.mados.invoke("servers.connect", { address: server.address, name: server.name });
      } catch (caught) {
        setStartupError((caught as Error).message);
      }
    }
  }, [profiles, state?.activeAccount?.id, useProfile]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setNotificationsOpen(false);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  if (startupError && !state) {
    return <FatalError message={startupError} onRetry={() => window.location.reload()} />;
  }

  if (!state) {
    return <LoadingScreen startupState={startupState} />;
  }

  if (!state.loggedIn || state.activeAccount?.status === "expired") {
    return <><LoginScreen onLoggedIn={setState} expired={state.activeAccount?.status === "expired"} /><div className="login-update-notice"><LauncherUpdateView update={shellUpdate} /></div></>;
  }

  return (
    <div className="app-shell">
      <TitleBar unreadNotifications={notificationUnreadCount(notifications)} onToggleNotifications={() => setNotificationsOpen((open) => !open)} onOpenPalette={() => setPaletteOpen(true)} />
      <div className="app-layout">
        <Sidebar state={state} tab={tab} setTab={setTab} onStateChange={setState} onAddAccount={() => setAccountLoginOpen(true)} />
        <main className="main-content">
          <div className="content-scroll">
            <div className="global-status-stack">
              {!online && <div className="offline-banner"><AlertTriangle size={16} /> Нет соединения с интернетом. Кэшированные данные остаются доступны.</div>}
              {state.compatibility && <CompatibilityBanner state={state} onStateChange={setState} />}
              {startupError && <InlineError message={startupError} onClose={() => setStartupError(null)} />}
              <LauncherUpdateView update={shellUpdate} launchBusy={Boolean(connection && !["ClientExited", "Cancelled", "ConnectionFailed", "UpdateError", "NotAContentBundle", "Error"].includes(connection.status))} />
            </div>
            {tab === "home" && <HomeView playing={connection?.status === "ClientRunning"} launchBusy={Boolean(connection && !["Cancelled", "ConnectionFailed", "UpdateError", "NotAContentBundle", "Error"].includes(connection.status))} state={state} onNavigate={setTab} onStateChange={setState} profiles={profiles} profilesBusy={profilesBusy} onUseProfile={useProfile} onCreateProfile={createProfile} onUpdateProfile={updateProfile} onRemoveProfile={removeProfile} />}
            {tab === "servers" && <ServersView state={state} tool={catalogTool} onToolChange={setCatalogTool} onStateChange={setState} profiles={profiles} profilesBusy={profilesBusy} onUseProfile={useProfile} onCreateProfile={createProfile} onUpdateProfile={updateProfile} onRemoveProfile={removeProfile} />}
            {tab === "news" && <NewsView />}
            {tab === "playtime" && <PlaytimeView state={state} onNavigate={setTab} />}
            {tab === "tools" && <ToolsView onError={setStartupError} launchProfiles={profiles} launchProfilesBusy={profilesBusy} onUseLaunchProfile={useProfile} onCreateLaunchProfile={createProfile} onUpdateLaunchProfile={updateProfile} onRemoveLaunchProfile={removeProfile} />}
            {tab === "settings" && <SettingsView settings={settings} setSettings={setSettings} theme={theme} setTheme={setTheme} discordStatus={discordStatus} shellUpdate={shellUpdate} launchBusy={Boolean(connection && !["ClientExited", "Cancelled", "ConnectionFailed", "UpdateError", "NotAContentBundle", "Error"].includes(connection.status))} />}
          </div>
          {connection && <LaunchDock activity={connection} onDismiss={() => setConnection(null)} />}
        </main>
      </div>
      {dragActive && <div className="drop-overlay"><div className="drop-card"><Download size={28} /><strong>Отпустите .zip здесь</strong><span>Контент-бандл или реплей откроется через C# worker</span></div></div>}
      {accountLoginOpen && <LoginScreen mode="add" onLoggedIn={(next) => { setState(next); setAccountLoginOpen(false); }} onCancel={() => setAccountLoginOpen(false)} />}
      {notificationsOpen && <NotificationJournal notifications={notifications} onRead={(item) => void markNotificationRead(item)} onClear={() => void clearNotifications()} onClose={() => setNotificationsOpen(false)} />}
      {toast && <NotificationToast notification={toast} onClose={() => setToast(null)} onOpen={() => { setNotificationsOpen(true); void markNotificationRead(toast); setToast(null); }} />}
      {paletteOpen && <CommandPalette open={paletteOpen} state={state} profiles={profiles} hasLastServer={Boolean(localStorage.getItem(lastServerStorageKey(state.activeAccount?.id)))} onClose={() => setPaletteOpen(false)} onExecute={(action) => { void executePaletteAction(action); setPaletteOpen(false); }} />}
    </div>
  );
}

function TitleBar({ unreadNotifications, onToggleNotifications, onOpenPalette }: { unreadNotifications: number; onToggleNotifications: () => void; onOpenPalette: () => void }) {
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
        <button className="title-action" aria-label="Командная палитра" data-tooltip="Команды (Ctrl+K)" onClick={onOpenPalette}><Command size={15} /></button>
        <button className="title-action notification-trigger" aria-label="Уведомления" data-tooltip="Уведомления" onClick={onToggleNotifications}><Bell size={15} />{unreadNotifications > 0 && <span className="notification-badge">{unreadNotifications > 9 ? "9+" : unreadNotifications}</span>}</button>
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
        <button className="sidebar-toggle" aria-label={collapsed ? "Развернуть панель" : "Свернуть панель"} data-tooltip={collapsed ? "Развернуть панель" : "Свернуть панель"} onClick={toggleCollapsed}><span className="sidebar-toggle-glyph">{collapsed ? <PanelLeftOpen size={18} strokeWidth={2.1} /> : <PanelLeftClose size={18} strokeWidth={2.1} />}</span></button>
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
  const [error, setError] = useState<string | null>(null);
  const switchAccount = async (account: Account) => {
    setSwitching(true);
    setError(null);
    try {
      await window.mados.invoke<Account>("auth.switchAccount", { accountId: account.id });
      onStateChange(await window.mados.invoke<LauncherState>("app.getState"));
    } catch (caught) {
      setError((caught as Error).message);
    } finally { setSwitching(false); }
  };
  const logout = async () => {
    setError(null);
    try {
      await window.mados.invoke("auth.logout", { accountId: state.activeAccount?.id });
      onStateChange(await window.mados.invoke<LauncherState>("app.getState"));
    } catch (caught) {
      setError((caught as Error).message);
    }
  };
  return (
    <div className="account-menu popover">
      <div className="popover-label">Аккаунты</div>
      {error && <div className="popover-error">{error}</div>}
      {state.accounts.map((account) => <button key={account.id} className="account-option" disabled={switching} onClick={() => void switchAccount(account)}><span className={`status-dot ${account.status === "expired" ? "expired" : ""}`} />{account.username ?? "Аккаунт"}<Check size={14} className={account.active ? "visible" : "hidden"} /></button>)}
      <button className="account-option account-add" onClick={() => { onAddAccount(); }}><Plus size={15} />Добавить аккаунт</button>
      <div className="popover-divider" />
      <button className="account-option danger-text" onClick={() => void logout()}><LogOut size={15} />Выйти</button>
    </div>
  );
}

function HomeView({ playing, launchBusy, state, onNavigate, onStateChange, profiles, profilesBusy, onUseProfile, onCreateProfile, onUpdateProfile, onRemoveProfile }: { playing: boolean; launchBusy: boolean; state: LauncherState; onNavigate: (tab: Tab) => void; onStateChange: (state: LauncherState) => void; profiles: LaunchProfile[]; profilesBusy: boolean; onUseProfile: (profile: LaunchProfile) => void | Promise<void>; onCreateProfile: (draft: LaunchProfileDraft) => void | Promise<void>; onUpdateProfile: (id: string, draft: LaunchProfileDraft) => void | Promise<void>; onRemoveProfile: (profile: LaunchProfile) => void | Promise<void> }) {
  const [lastServer, setLastServer] = useState<Server | null>(null);
  const [selectedHomeServer, setSelectedHomeServer] = useState<Server | null>(null);
  const [busy, setBusy] = useState(false);
  const [recentConnections, setRecentConnections] = useState<RecentConnection[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  useEffect(() => {
    const storageKey = lastServerStorageKey(state.activeAccount?.id);
    setLastServer(null);
    setSelectedHomeServer(null);
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try { setLastServer(JSON.parse(stored) as Server); } catch { localStorage.removeItem(storageKey); }
    }
  }, [state.activeAccount?.id]);
  useEffect(() => {
    let cancelled = false;
    setRecentLoading(true);
    setRecentError(null);
    setRecentConnections([]);
    void window.mados.invoke<RecentConnection[]>("recentConnections.list", { limit: 6 }).then((items) => {
      if (!cancelled) setRecentConnections(sortRecentConnections(items, "recent"));
    }).catch((caught: Error) => {
      if (!cancelled) setRecentError(caught.message);
    }).finally(() => {
      if (!cancelled) setRecentLoading(false);
    });
    const unsubscribe = window.mados.onEvent((event) => {
      const connected = event.event === "recentConnections.updated"
        || (event.event === "connection.progress" && (event.data as ConnectionProgress).status === "ClientRunning");
      if (!connected) return;
      void window.mados.invoke<RecentConnection[]>("recentConnections.list", { limit: 6 }).then((items) => {
        if (!cancelled) {
          setRecentConnections(sortRecentConnections(items, "recent"));
          setRecentError(null);
        }
      }).catch((caught: Error) => {
        if (!cancelled) setRecentError(caught.message);
      });
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [state.activeAccount?.id]);
  const connect = async (server: Server) => {
    setBusy(true);
    const safeAddress = sanitizeServerAddress(server.address);
    if (safeAddress) localStorage.setItem(lastServerStorageKey(state.activeAccount?.id), JSON.stringify({ ...server, address: safeAddress }));
    setLastServer(server);
    setFavoriteError(null);
    try { await window.mados.invoke("servers.connect", { address: server.address, name: server.name }); } catch (caught) { setFavoriteError((caught as Error).message); } finally { setBusy(false); }
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
      <div className="page-heading"><div><p className="eyebrow">Добро пожаловать обратно</p><h1>{state.activeAccount?.username ?? "Mados"}</h1><p className="page-subtitle">Готовы вернуться на станцию?</p></div><div className="heading-actions"><button className="icon-button" aria-label="Справка" data-tooltip="Справка по лаунчеру" onClick={() => void window.mados.openExternal("https://github.com/Endennsss/mados_launcher#readme")}><CircleHelp size={18} /></button></div></div>
      <LastServerCard key={`${state.activeAccount?.id}:${recentConnections[0]?.address ?? lastServer?.address ?? "empty"}`} accountId={state.activeAccount?.id}
        server={recentConnections[0] ? serverFromRecentConnection(recentConnections[0]) : lastServer} recent={recentConnections[0]}
        loading={recentLoading} playing={playing} busy={busy || launchBusy} onConnect={server => void connect(server)} onBrowse={() => onNavigate("servers")} onDetails={setSelectedHomeServer} />
      <div className="section-heading"><div><h2>Недавние подключения</h2><span>{recentConnections.length} серверов</span></div><button className="ghost-button" onClick={() => onNavigate("servers")}>Каталог <ArrowRight className="action-arrow" size={15} /></button></div>
      {recentError && <InlineError message={recentError} onClose={() => setRecentError(null)} />}
      {recentLoading ? <div className="recent-connection-grid">{Array.from({ length: 3 }, (_, index) => <div className="recent-connection-skeleton" key={index} />)}</div> : recentConnections.length > 0 ? <div className="recent-connection-grid">{sortRecentConnections(recentConnections, "recent").map((recent) => <RecentConnectionCard key={recent.address} connection={recent} onConnect={() => void connect(serverFromRecentConnection(recent))} onDetails={() => setSelectedHomeServer(serverFromRecentConnection(recent))} />)}</div> : <EmptyState icon={<Clock3 size={23} />} title="Недавних подключений пока нет" description="Подключитесь к серверу, и он появится здесь после успешного запуска игры." action="Открыть каталог" onAction={() => onNavigate("servers")} />}
      <div className="section-heading"><div><h2>Избранные серверы</h2><span>{state.favorites.length} сохранено</span></div><button className="ghost-button" onClick={() => onNavigate("servers")}>Все серверы <ArrowRight className="action-arrow" size={15} /></button></div>
      {favoriteError && <InlineError message={favoriteError} onClose={() => setFavoriteError(null)} />}
      {state.favorites.length > 0 ? <div className="favorite-grid">{state.favorites.slice(0, 4).map((favorite) => <FavoriteCard key={favorite.address} favorite={favorite} onConnect={() => void connect(serverFromFavorite(favorite))} onRemove={() => void removeFavorite(favorite)} onDetails={() => setSelectedHomeServer(serverFromFavorite(favorite))} />)}</div> : <EmptyState icon={<Star size={23} />} title="Избранных серверов пока нет" description="Сохраните серверы, к которым возвращаетесь чаще всего." action="Открыть каталог" onAction={() => onNavigate("servers")} />}
      <div className="quick-actions"><button className="quick-action" onClick={() => onNavigate("servers")}><Globe2 size={18} /><span><strong>Каталог серверов</strong><small>Найти новую станцию</small></span><ArrowRight className="action-arrow" size={16} /></button><button className="quick-action" onClick={() => void openContentBundle().catch((caught: Error) => setFavoriteError(caught.message))}><Download size={18} /><span><strong>Открыть контент-бандл</strong><small>Запустить .zip или реплей</small></span><ArrowRight className="action-arrow" size={16} /></button></div>
      <LaunchProfiles profiles={profiles} busy={profilesBusy} onUse={onUseProfile} onCreate={onCreateProfile} onUpdate={onUpdateProfile} onRemove={onRemoveProfile} />
    </section>
    {selectedHomeServer && <ServerDetailsPanel key={`${state.activeAccount?.id}:${selectedHomeServer.address}`} accountId={state.activeAccount?.id} server={selectedHomeServer} onClose={() => setSelectedHomeServer(null)} onConnect={() => { setSelectedHomeServer(null); void connect(selectedHomeServer); }} />}
    </>
  );
}

function serverFromFavorite(favorite: Favorite): Server {
  return { address: favorite.address, name: favorite.name, playerCount: 0, softMaxPlayerCount: 0, roundStartTime: null, runLevel: null, tags: [], status: "online", hubAddress: "" };
}

function lastServerStorageKey(accountId: string | null | undefined): string {
  return `mados.lastServer.${accountId || "anonymous"}`;
}

function serverFromRecentConnection(connection: RecentConnection): Server {
  return {
    address: connection.address,
    name: connection.name,
    playerCount: connection.playerCount ?? 0,
    softMaxPlayerCount: 0,
    roundStartTime: null,
    runLevel: null,
    tags: [],
    status: "online",
    hubAddress: "",
    pingMs: connection.pingMs,
  };
}

function RecentConnectionCard({ connection, onConnect, onDetails }: { connection: RecentConnection; onConnect: () => void; onDetails: () => void }) {
  const safeAddress = sanitizeServerAddress(connection.address) || "Адрес скрыт";
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); queueServerHandoff(connection.address, event.currentTarget, "details"); onDetails(); }
  };
  return <article data-server-address={safeAddress} className="recent-connection-card" role="button" tabIndex={0} aria-label={`Подробнее о сервере ${connection.name || safeAddress}`} onClick={(event) => { if (!(event.target as HTMLElement).closest("button,a,input")) { queueServerHandoff(connection.address, event.currentTarget, "details"); onDetails(); } }} onKeyDown={handleKeyDown}><div className="recent-connection-head"><ServerMark /><time dateTime={connection.lastConnectedAt}>{new Date(connection.lastConnectedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time><Clock3 size={14} className="muted-icon" /></div><h3>{connection.name || safeAddress}</h3><p>{safeAddress}</p><div className="recent-connection-meta" data-tooltip="Последние известные данные при подключении"><span><Users size={13} /> {connection.playerCount == null ? "—" : `${connection.playerCount} игроков`}</span><span><Activity size={13} /> {connection.pingMs == null ? "—" : `${connection.pingMs} ms`}</span></div><button className="card-connect" onClick={(event) => { event.stopPropagation(); queueServerHandoff(connection.address, event.currentTarget, "launch"); onConnect(); }}>Подключиться <ArrowRight className="action-arrow" size={14} /></button></article>;
}

function FavoriteCard({ favorite, onConnect, onRemove, onDetails }: { favorite: Favorite; onConnect: () => void; onRemove: () => void; onDetails: () => void }) {
  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button,a,input")) return;
    queueServerHandoff(favorite.address, event.currentTarget, "details"); onDetails();
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); queueServerHandoff(favorite.address, event.currentTarget, "details"); onDetails(); }
  };
  const safeAddress = sanitizeServerAddress(favorite.address) || "Адрес скрыт";
  return <article data-server-address={safeAddress} className="favorite-card" role="button" tabIndex={0} aria-label={`Подробнее об избранном сервере ${favorite.name || safeAddress}`} onClick={handleCardClick} onKeyDown={handleKeyDown}><div className="favorite-card-top"><ServerMark /><span className="server-status online" /><button className="favorite-star" aria-label="Удалить из избранного" onClick={(event) => { event.stopPropagation(); onRemove(); }}><Star size={16} fill="currentColor" /></button></div><h3>{favorite.name || "Без названия"}</h3><p>{safeAddress}</p><button className="card-connect" onClick={(event) => { event.stopPropagation(); queueServerHandoff(favorite.address, event.currentTarget, "launch"); onConnect(); }}>Подключиться <ArrowRight className="action-arrow" size={14} /></button></article>;
}

function FavoriteMonitoring({ summaries, loading, error, onRefresh }: { summaries: FavoriteMonitorSummary[]; loading: boolean; error: string | null; onRefresh: () => void }) {
  return <section className="monitoring-section"><div className="section-heading"><div><p className="eyebrow">Живой статус</p><h2>Избранное сейчас</h2><span>Проверяется только при ручном обновлении каталога</span></div><button className="icon-button" onClick={onRefresh} disabled={loading} aria-label="Обновить мониторинг" data-tooltip="Обновить мониторинг"><RefreshCw size={17} className={loading ? "spin" : "refresh-once"} /></button></div>{error && <div className="monitoring-error"><AlertTriangle size={15} /><span>{error}</span></div>}{loading && summaries.length === 0 ? <div className="monitoring-grid">{Array.from({ length: 2 }, (_, index) => <div className="monitoring-skeleton" key={index} />)}</div> : summaries.length === 0 ? <div className="monitoring-empty"><Activity size={19} /><div><strong>Нет избранных серверов для мониторинга</strong><span>Добавьте сервер в избранное, затем обновите каталог.</span></div></div> : <div className="monitoring-grid">{summaries.map((summary, index) => <FavoriteMonitorCard key={summary.address} summary={summary} style={{ "--monitor-index": index } as CSSProperties} />)}</div>}</section>;
}

function FavoriteMonitorCard({ summary, style }: { summary: FavoriteMonitorSummary; style?: CSSProperties }) {
  const safeAddress = sanitizeServerAddress(summary.address) || "Адрес скрыт";
  const points = sparklinePoints(summary.samples);
  const stateLabel = summary.isOnline ? "Онлайн" : summary.samples.length === 0 ? "Нет данных" : "Недоступен";
  return <article className={`monitoring-card ${summary.isOnline ? "online" : "offline"}`} style={style}><div className="monitoring-card-head"><span className="monitoring-status"><span className="server-status" />{stateLabel}</span>{summary.isOnline ? <Wifi size={15} /> : <WifiOff size={15} />}</div><h3>{summary.name || safeAddress}</h3><p className="monitoring-address">{safeAddress}</p><div className="monitoring-stats"><div><span>Онлайн</span><strong>{summary.playerCount == null ? "—" : `${summary.playerCount}${summary.softMaxPlayerCount ? ` / ${summary.softMaxPlayerCount}` : ""}`}</strong>{summary.playerDelta != null && <small className={summary.playerDelta > 0 ? "positive" : summary.playerDelta < 0 ? "negative" : ""}>{formatDelta(summary.playerDelta, " игроков")}</small>}</div><div><span>Ping</span><strong>{summary.pingMs == null ? "—" : `${summary.pingMs} ms`}</strong>{summary.pingDeltaMs != null && <small className={summary.pingDeltaMs > 0 ? "negative" : summary.pingDeltaMs < 0 ? "positive" : ""}>{formatDelta(summary.pingDeltaMs, " ms")}</small>}</div>{points && <svg className="monitoring-sparkline" viewBox="0 0 120 34" role="img" aria-label="История ping за 30 дней"><polyline points={points} /></svg>}</div><div className="monitoring-card-foot"><span>{summary.samples.length > 0 ? `Обновлено ${formatDurationSince(summary.samples[summary.samples.length - 1].capturedAt)}` : "Ожидает проверки"}</span><span>{summary.samples.length} замеров</span></div></article>;
}

function ServersView({ state, tool, onToolChange, onStateChange, profiles, profilesBusy, onUseProfile, onCreateProfile, onUpdateProfile, onRemoveProfile }: { state: LauncherState; tool: CatalogTool | null; onToolChange: (tool: CatalogTool | null) => void; onStateChange: (state: LauncherState) => void; profiles: LaunchProfile[]; profilesBusy: boolean; onUseProfile: (profile: LaunchProfile) => void | Promise<void>; onCreateProfile: (draft: LaunchProfileDraft) => void | Promise<void>; onUpdateProfile: (id: string, draft: LaunchProfileDraft) => void | Promise<void>; onRemoveProfile: (profile: LaunchProfile) => void | Promise<void> }) {
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
  const [noteAddresses, setNoteAddresses] = useState<Set<string>>(new Set());
  const [monitoring, setMonitoring] = useState<FavoriteMonitorSummary[]>([]);
  const [monitoringLoading, setMonitoringLoading] = useState(false);
  const [monitoringError, setMonitoringError] = useState<string | null>(null);
  const utilitiesRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (tool) utilitiesRef.current?.scrollIntoView?.({ block: "nearest" }); }, [tool]);
  const loadSequence = useRef(0);
  const catalogSnapshot = useRef<ServerListResult | null>(null);

  const applyCatalog = useCallback((incoming: ServerListResult) => {
    const next = acceptCatalogSnapshot(catalogSnapshot.current, incoming);
    setLoading(next.refreshing === true);
    if (next === catalogSnapshot.current) return;
    catalogSnapshot.current = next;
    setServers(next.servers);
    setError(catalogError(next));
  }, []);

  const loadMonitoring = useCallback(async (refresh = false) => {
    setMonitoringLoading(true);
    setMonitoringError(null);
    try {
      const result = refresh ? await window.mados.monitoring.refresh() : await window.mados.monitoring.getFavorites();
      setMonitoring(Array.isArray(result?.favorites) ? result.favorites : []);
    } catch (caught) {
      try {
        const items = await window.mados.monitoring.getFavorites();
        setMonitoring(Array.isArray(items?.favorites) ? items.favorites : []);
      } catch {
        setMonitoringError((caught as Error).message);
      }
    } finally {
      setMonitoringLoading(false);
    }
  }, []);

  const load = useCallback(async (manual = false) => {
    const sequence = ++loadSequence.current;
    setLoading(true); setError(null);
    try {
      const result = await window.mados.invoke<ServerListResult>(manual ? "servers.refresh" : "servers.list");
      if (sequence !== loadSequence.current) return;
      applyCatalog(result);
    } catch (e) {
      if (sequence === loadSequence.current) {
        setError((e as Error).message);
        setLoading(false);
      }
    }
  }, [applyCatalog]);
  useEffect(() => {
    let cancelled = false;
    setMonitoring([]);
    setMonitoringError(null);
    void window.mados.monitoring.getFavorites().then((result) => {
      if (!cancelled) setMonitoring(Array.isArray(result?.favorites) ? result.favorites : []);
    }).catch(() => {
      if (!cancelled) setMonitoring([]);
    });
    return () => { cancelled = true; };
  }, [state.activeAccount?.id]);
  useEffect(() => {
    const refreshListener = () => { void load(true); };
    window.addEventListener("servers-refresh-requested", refreshListener);
    const unsubscribe = window.mados.onEvent((event) => {
      if (event.event === "servers.updated") {
        const result = event.data as ServerListResult;
        if (Array.isArray(result?.servers)) applyCatalog(result);
      }
      if (event.event === "monitoring.updated") {
        const payload = event.data as { accountId?: string; favorites?: FavoriteMonitorSummary[] } | FavoriteMonitorSummary[];
        if (!Array.isArray(payload) && payload.accountId && payload.accountId !== state.activeAccount?.id) return;
        const items = Array.isArray(payload) ? payload : payload.favorites;
        if (Array.isArray(items)) setMonitoring(items);
        setMonitoringError(null);
      }
      if (event.event === "monitoring.failed") {
        const payload = event.data as FavoriteMonitoringFailure;
        if (payload.accountId !== state.activeAccount?.id) return;
        if (Array.isArray(payload.favorites)) setMonitoring(payload.favorites);
        setMonitoringError(payload.message);
      }
    });
    return () => {
      window.removeEventListener("servers-refresh-requested", refreshListener);
      unsubscribe();
    };
  }, [applyCatalog, load, state.activeAccount?.id]);
  useEffect(() => {
    void load();
    return () => { loadSequence.current += 1; };
  }, [load]);
  const loadNotes = useCallback(async () => {
    try {
      const notes = await window.mados.serverNotes.list();
      setNoteAddresses(new Set(notes.map((note) => note.address)));
    } catch {
      setNoteAddresses(new Set());
    }
  }, []);

  useEffect(() => { void loadNotes(); }, [loadNotes, state.activeAccount?.id]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim().toLowerCase()), 180);
    return () => window.clearTimeout(timer);
  }, [queryInput]);
  const filterOptions = useMemo(() => Array.from(new Set(servers.flatMap((server) => server.tags.filter((tag) => /^(lang:|region:|rp:|mode:|map:|18\+|am_|as_|af_|eu_|oce|ind|me|luna|grl|ata)/i.test(tag))))).sort(), [servers]);
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
    const safeAddress = sanitizeServerAddress(server.address);
    if (safeAddress) localStorage.setItem(lastServerStorageKey(state.activeAccount?.id), JSON.stringify({ ...server, address: safeAddress }));
    try { await window.mados.invoke("servers.connect", { address: server.address, name: server.name }); }
    catch (caught) { setError((caught as Error).message); }
  };
  const connectDirect = async () => {
    const address = directAddress.trim();
    if (!/^(ss14|ss14s):\/\//i.test(address)) { setError("Адрес должен начинаться с ss14:// или ss14s://"); return; }
    try {
      await window.mados.invoke("servers.connect", { address });
      const safeAddress = sanitizeServerAddress(address);
      if (safeAddress) localStorage.setItem(lastServerStorageKey(state.activeAccount?.id), JSON.stringify({ address: safeAddress, name: "Прямое подключение", playerCount: 0, softMaxPlayerCount: 0, tags: [], status: "fetching", hubAddress: "" }));
      setDirectAddress("");
    } catch (caught) { setError((caught as Error).message); }
  };
  const toggleFavorite = async (server: Server) => {
    const exists = state.favorites.some((favorite) => favorite.address === server.address);
    try {
      const favorites = await window.mados.invoke<Favorite[]>(exists ? "favorites.remove" : "favorites.add", exists ? { address: server.address } : { address: server.address, name: server.name });
      onStateChange({ ...state, favorites });
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  return <>
    <section className="page page-enter catalog-page">
    <div className="page-heading"><div><p className="eyebrow">Игровые миры</p><h1>Серверы</h1><p className="page-subtitle">{loading && servers.length > 0 ? "Обновляем данные серверов — уже можно подключаться." : "Найдите станцию для следующей смены."}</p></div><button className="icon-button" onClick={() => void load(true)} disabled={loading} aria-label="Обновить"><RefreshCw size={18} className={loading ? "spin" : ""} /></button></div>
    <div className="toolbar"><label className="search-box"><Search size={17} /><input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="Поиск по названию или адресу" /></label><button className={`filter-button ${showFilters ? "active" : ""}`} onClick={() => setShowFilters((value) => !value)}><SlidersHorizontal size={16} /> Фильтры {(onlyPopulated || selectedTags.length > 0) && <span className="filter-count">{selectedTags.length + (onlyPopulated ? 1 : 0)}</span>}</button><SelectField className="sort-select" label="Сортировка серверов" value={sort} onChange={value => setSort(value as typeof sort)} options={[{value: "players", label: "По онлайну"}, {value: "name", label: "По названию"}]} /></div>
    {showFilters && <div className="filter-drawer"><div className="filter-drawer-head"><div><strong>Фильтры серверов</strong><span>Настройте каталог под себя</span></div>{(onlyPopulated || selectedTags.length > 0) && <button className="filter-reset" onClick={() => { setSelectedTags([]); setOnlyPopulated(false); localStorage.removeItem("mados.serverFilters"); }}>Сбросить</button>}</div><div className="filter-chip-list"><button className={`filter-chip ${onlyPopulated ? "selected" : ""}`} onClick={() => setOnlyPopulated((value) => !value)}><Users size={15} /> Только с игроками</button>{filterOptions.map((tag) => <button key={tag} className={`filter-chip ${selectedTags.includes(tag) ? "selected" : ""}`} onClick={() => toggleTag(tag)}>{formatFilterTag(tag)}</button>)}{filterOptions.length === 0 && <span className="filter-hint">Фильтры появятся после загрузки тегов серверов.</span>}</div></div>}
    {error && <InlineError message={error} onClose={() => setError(null)} />}
    <div ref={utilitiesRef} className="catalog-utilities" aria-label="Дополнительно в каталоге">
      <button id="catalog-monitoring-toggle" className="catalog-utility-toggle" aria-expanded={tool === "monitoring"} aria-controls="catalog-monitoring" onClick={() => onToolChange(tool === "monitoring" ? null : "monitoring")}><Activity size={15} />Избранное сейчас<span className="utility-count">{state.favorites.length}</span>{monitoringError && <AlertTriangle size={13} className="utility-warning" />}<ChevronDown size={14} /></button>
      <button id="catalog-profiles-toggle" className="catalog-utility-toggle" aria-expanded={tool === "profiles"} aria-controls="catalog-profiles" onClick={() => onToolChange(tool === "profiles" ? null : "profiles")}><Play size={14} />Профили<span className="utility-count">{profiles.length}</span><ChevronDown size={14} /></button>
      <button id="catalog-direct-toggle" className="catalog-utility-toggle" aria-expanded={tool === "direct"} aria-controls="catalog-direct" onClick={() => onToolChange(tool === "direct" ? null : "direct")}><TerminalSquare size={15} />По адресу<ChevronDown size={14} /></button>
      <span className="catalog-result-count">{filtered.length} {pluralize(filtered.length, "сервер", "сервера", "серверов")}</span>
    </div>
    {monitoringError && tool !== "monitoring" && <div className="catalog-monitoring-warning" role="status"><AlertTriangle size={14} /><span>{monitoringError}</span><button className="text-link" onClick={() => onToolChange("monitoring")}>Подробнее <ArrowRight size={13} /></button></div>}
    <div className="catalog-utility-panel" id="catalog-monitoring" role="region" aria-labelledby="catalog-monitoring-toggle" hidden={tool !== "monitoring"}><FavoriteMonitoring summaries={monitoring} loading={monitoringLoading} error={monitoringError} onRefresh={() => void loadMonitoring(true)} /></div>
    <div className="catalog-utility-panel" id="catalog-profiles" role="region" aria-labelledby="catalog-profiles-toggle" hidden={tool !== "profiles"}><LaunchProfiles key={state.activeAccount?.id} profiles={profiles} busy={profilesBusy} onUse={onUseProfile} onCreate={onCreateProfile} onUpdate={onUpdateProfile} onRemove={onRemoveProfile} /></div>
    <div className="catalog-utility-panel" id="catalog-direct" role="region" aria-labelledby="catalog-direct-toggle" hidden={tool !== "direct"}><div className="direct-connect"><TerminalSquare size={16} /><input aria-label="Адрес сервера" value={directAddress} onChange={(event) => setDirectAddress(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void connectDirect(); }} placeholder="ss14://адрес сервера" /><button className="primary-button" onClick={() => void connectDirect()} disabled={!directAddress.trim()}><ArrowRight size={15} />Подключиться</button></div></div>
    {loading && servers.length === 0 ? <div className="server-grid">{Array.from({ length: 6 }, (_, index) => <div className="server-skeleton" key={index}><span /><span /><span /></div>)}</div> : filtered.length > 0 ? <div className="server-grid">{filtered.map((server) => <ServerCard key={server.address} server={server} favorite={state.favorites.some((favorite) => favorite.address === server.address)} hasNote={noteAddresses.has(sanitizeServerAddress(server.address))} onConnect={() => void connect(server)} onFavorite={() => void toggleFavorite(server)} onDetails={() => setSelectedServer(server)} />)}</div> : <EmptyState icon={<Search size={23} />} title="Ничего не найдено" description="Измените запрос или сбросьте фильтры." action="Сбросить фильтры" onAction={() => { setQueryInput(""); setSelectedTags([]); setOnlyPopulated(false); localStorage.removeItem("mados.serverFilters"); }} />}
    </section>
    {selectedServer && <ServerDetailsPanel key={`${state.activeAccount?.id}:${selectedServer.address}`} accountId={state.activeAccount?.id} server={selectedServer} onClose={() => { setSelectedServer(null); void loadNotes(); }} onConnect={() => { setSelectedServer(null); void connect(selectedServer); }} />}
  </>;
}

function ServerCard({ server, favorite, hasNote, onConnect, onFavorite, onDetails }: { server: Server; favorite: boolean; hasNote: boolean; onConnect: () => void; onFavorite: () => void; onDetails: () => void }) {
  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button,a,input")) return;
    queueServerHandoff(server.address, event.currentTarget, "details"); onDetails();
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); queueServerHandoff(server.address, event.currentTarget, "details"); onDetails(); }
  };
  const safeAddress = sanitizeServerAddress(server.address) || "Адрес скрыт";
  return <article data-server-address={safeAddress} className="server-card" role="button" tabIndex={0} aria-label={`Подробнее о сервере ${server.name || safeAddress}`} onClick={handleCardClick} onKeyDown={handleKeyDown}><div className="server-card-head"><ServerMark /><span className={`server-status ${server.status === "online" ? "online" : "offline"}`} /><span className="server-status-label">{server.status === "online" ? "Онлайн" : "Недоступен"}</span>{hasNote && <span className="server-note-indicator" data-tooltip="Есть заметка"><StickyNote size={13} /></span>}<button className={`star-button ${favorite ? "selected" : ""}`} onClick={(event) => { event.stopPropagation(); onFavorite(); }} aria-label={favorite ? "Удалить из избранного" : "Добавить в избранное"}><Star size={17} fill={favorite ? "currentColor" : "none"} /></button></div><h3>{server.name || "Без названия"}</h3><p className="server-address">{safeAddress}</p><div className="server-meta"><span><Users size={14} /> {server.playerCount}{server.softMaxPlayerCount > 0 ? ` / ${server.softMaxPlayerCount}` : ""}</span><span><Activity size={14} /> {server.pingMs == null ? "—" : `${server.pingMs} ms`}</span><span><Globe2 size={14} /> {server.language || "—"}</span></div>{server.map && <div className="server-map">Карта: {server.map}</div>}<div className="tag-row">{server.tags.slice(0, 3).map((tag) => <span className="tag" key={tag}>{formatFilterTag(tag)}</span>)}</div><button className="primary-button full-button" disabled={server.status !== "online"} onClick={(event) => { event.stopPropagation(); queueServerHandoff(server.address, event.currentTarget, "launch"); onConnect(); }}><Play className="play-icon" size={16} fill="currentColor" /> Подключиться</button></article>;
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
  const mode = /^mode:(.+)$/i.exec(tag);
  if (mode) return `Режим · ${mode[1]}`;
  const map = /^map:(.+)$/i.exec(tag);
  if (map) return `Карта · ${map[1]}`;
  const eighteen = /^18\+:(true|false)$/i.exec(tag);
  if (eighteen) return eighteen[1].toLowerCase() === "true" ? "18+" : "Без 18+";
  if (/^18\+$/i.test(tag)) return "18+";
  return tag.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function NewsView() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const load = async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setError(null);
    try {
      const nextItems = await window.mados.invoke<NewsItem[]>("news.list");
      if (sequence === loadSequence.current) setItems(nextItems);
    } catch (e) {
      if (sequence === loadSequence.current) setError((e as Error).message);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  return <section className="page page-enter"><div className="page-heading"><div><p className="eyebrow">Последние обновления</p><h1>Новости</h1><p className="page-subtitle">События Space Station 14 и релизы Mados Launcher с GitHub.</p></div><button className="icon-button" onClick={() => void load()} aria-label="Обновить"><RefreshCw size={18} className={loading ? "spin" : ""} /></button></div>{error && <InlineError message={error} onClose={() => setError(null)} />}{loading ? <div className="news-list">{Array.from({ length: 3 }, (_, index) => <div className="news-skeleton" key={index} />)}</div> : <div className="news-list">{items.map((item, index) => <article className="news-card" key={`${item.link}-${index}`}><div className="news-icon"><Newspaper size={18} /></div><div className="news-copy"><span className="eyebrow">{item.source ?? "Space Station 14"}{item.date ? ` · ${new Date(item.date).toLocaleDateString()}` : ""}</span><h3>{item.title}</h3>{item.summary && <p className="news-summary">{item.summary}</p>}<button className="text-link" onClick={() => void window.mados.openExternal(item.link)}>Открыть публикацию <ExternalLink className="external-link" size={14} /></button></div></article>)}{items.length === 0 && <EmptyState icon={<Newspaper size={23} />} title="Новостей пока нет" description="Попробуйте обновить ленту позже." action="Повторить" onAction={() => void load()} />}</div>}</section>;
}

function PlaytimeView({ state, onNavigate }: { state: LauncherState; onNavigate: (tab: Tab) => void }) {
  const confirm = useConfirm(state.activeAccount?.id);
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
    if (!await confirm({title: "Удалить историю игры?", message: "Удалить накопленное время текущего аккаунта? Текущая игровая сессия продолжит считаться.", confirmLabel: "Удалить историю", destructive: true})) return;
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
    <div className="page-heading"><div><p className="eyebrow">Личная статистика</p><h1>Время игры</h1><p className="page-subtitle">Сколько времени вы провели на разных серверах.</p></div><div className="heading-actions"><button className="icon-button" onClick={() => void load()} disabled={refreshing} aria-label="Обновить статистику" data-tooltip="Обновить статистику"><RefreshCw size={18} className={refreshing ? "refresh-once" : ""} /></button><button className="icon-button playtime-clear-button" onClick={() => void clearHistory()} disabled={clearing || !summary || summary.sessionCount === 0} aria-label="Удалить историю" data-tooltip="Удалить историю"><Trash2 size={18} /></button></div></div>
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

function SettingsView({ settings, setSettings, theme, setTheme, discordStatus, shellUpdate, launchBusy }: { settings: LauncherSettings | null; setSettings: (settings: LauncherSettings) => void; theme: ThemeId; setTheme: (theme: ThemeId) => void; discordStatus: DiscordPresenceStatus; shellUpdate: ShellUpdate; launchBusy: boolean }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => localStorage.getItem("mados.reducedMotion") === "true");
  const [section, setSection] = useState<"account" | "appearance" | "discord" | "compatibility" | "diagnostics" | "updates">("account");
  if (!settings) return <LoadingScreen />;
  const update = async (patch: Partial<LauncherSettings>) => { setSaving(true); setError(null); try { setSettings(await window.mados.invoke<LauncherSettings>("settings.update", patch)); } catch (caught) { setError((caught as Error).message); } finally { setSaving(false); } };
  const navItems: Array<{ id: typeof section; label: string; icon: typeof UserRound }> = [
    { id: "account", label: "Аккаунт", icon: UserRound },
    { id: "appearance", label: "Внешний вид", icon: Sparkles },
    { id: "discord", label: "Discord", icon: Radio },
    { id: "compatibility", label: "Совместимость", icon: ShieldCheck },
    { id: "diagnostics", label: "Диагностика", icon: TerminalSquare },
    { id: "updates", label: "Обновления", icon: Download },
  ];
  const discordLabel = discordStatus === "connected" ? "Discord подключён" : discordStatus === "disabled" ? "Rich Presence отключён" : "Discord не найден";
  const discordTone = discordStatus === "connected" ? "success" : discordStatus === "disabled" ? "muted" : "warning";
  return <section className="page page-enter"><div className="page-heading"><div><p className="eyebrow">Персонализация</p><h1>Настройки</h1><p className="page-subtitle">Управляйте аккаунтом и поведением лаунчера.</p></div>{saving && <LoaderCircle className="spin muted-icon" size={19} />}</div>{error && <InlineError message={error} onClose={() => setError(null)} />}<div className="settings-layout"><div className="settings-nav">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={`settings-nav-item ${section === id ? "active" : ""}`} onClick={() => setSection(id)}><Icon className="settings-nav-icon" size={16} /> {label}</button>)}</div><div className="settings-panels">{section === "updates" && <LauncherUpdateView update={shellUpdate} expanded launchBusy={launchBusy} />}{section === "account" && <SettingsGroup title="Аккаунт" icon={<UserRound size={18} />}><SettingRow title="Текущий аккаунт" description={"Активная сессия Mados Launcher"}><span className="setting-value"><span className="status-dot" />Активен</span></SettingRow><SettingRow title="Управление аккаунтом" description="Открыть настройки учётной записи на официальном сайте"><button className="secondary-button" onClick={() => void window.mados.openExternal(settings.accountManagementUrl)}>Открыть <ExternalLink className="external-link" size={14} /></button></SettingRow></SettingsGroup>}{section === "appearance" && <SettingsGroup title="Внешний вид" icon={<Sparkles size={18} />}><SettingRow title="Цветовая тема" description="Меняет только акцентные цвета интерфейса"><ThemePicker value={theme} onChange={setTheme} /></SettingRow><SettingRow title="Уменьшить движение" description="Отключить переходы и анимации интерфейса"><Toggle checked={reducedMotion} onChange={(checked) => { setReducedMotion(checked); localStorage.setItem("mados.reducedMotion", String(checked)); document.documentElement.classList.toggle("reduce-motion", checked); }} /></SettingRow><SettingRow title="Уведомления доступности избранных" description="Сообщать, когда избранный сервер снова появился онлайн"><Toggle checked={settings.favoriteAvailabilityNotifications} onChange={(checked) => void update({ favoriteAvailabilityNotifications: checked })} /></SettingRow><SettingRow title="Язык интерфейса" description="Русский и English доступны в текущей версии"><LanguageSelect value={settings.language ?? "auto"} onChange={(value) => void update({ language: value === "auto" ? null : value })} /></SettingRow></SettingsGroup>}{section === "discord" && <SettingsGroup title="Discord" icon={<Radio size={18} />}><SettingRow title="Rich Presence" description="Показывать состояние Mados Launcher и игры в Discord"><Toggle checked={settings.discordPresenceEnabled} onChange={(checked) => void update({ discordPresenceEnabled: checked })} /></SettingRow><SettingRow title="Показывать ник в Discord" description="Ник фиксируется в момент запуска соединения и не передаёт токены"><Toggle checked={settings.discordPresenceShowNickname} disabled={!settings.discordPresenceEnabled} onChange={(checked) => void update({ discordPresenceShowNickname: checked })} /></SettingRow><SettingRow title="Состояние Discord" description="Лаунчер продолжает работать, если Discord закрыт"><span className={`setting-value discord-status-value ${discordTone}`}><span className="status-dot" />{discordLabel}</span></SettingRow><details className="discord-advanced"><summary><span><strong>Расширенные настройки</strong><small>Дополнительная картинка для Discord не обязательна</small></span><ChevronDown size={15} /></summary><div className="discord-advanced-body"><p>Rich Presence работает и без картинки. Asset <code>mados-cat</code> добавляет большую иллюстрацию в Discord-статус.</p><button className="secondary-button" onClick={() => void window.mados.openExternal("https://discord.com/developers/applications/1555589477492199434/rich-presence/assets")}>Открыть инструкцию <ExternalLink className="external-link" size={14} /></button></div></details></SettingsGroup>}{section === "compatibility" && <SettingsGroup title="Совместимость" icon={<ShieldCheck size={18} />}><SettingRow title="Compatibility mode" description="Использовать безопасные графические параметры"><Toggle checked={settings.compatMode} onChange={(checked) => void update({ compatMode: checked })} /></SettingRow><SettingRow title="Seasonal assets" description="Разрешить загрузку официальных override-ассетов"><Toggle checked={settings.overrideAssets} onChange={(checked) => void update({ overrideAssets: checked })} /></SettingRow></SettingsGroup>}{section === "diagnostics" && <SettingsGroup title="Диагностика" icon={<TerminalSquare size={18} />}><SettingRow title="Подробное логирование" description="Нужно для разбора сложных проблем запуска"><Toggle checked={settings.verboseLogging} onChange={(checked) => void update({ verboseLogging: checked })} /></SettingRow><SettingRow title="Версия" description="Mados Launcher"><span className="setting-value">{shellUpdate.currentVersion}</span></SettingRow></SettingsGroup>}</div></div></section>;
}

function SettingsGroup({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) { return <section className="settings-group"><div className="settings-group-title"><span className="settings-group-icon">{icon}</span><h2>{title}</h2></div><div className="settings-rows">{children}</div></section>; }
function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) { return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div>{children}</div>; }
function Toggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) { return <button className={`toggle ${checked ? "checked" : ""}`} role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>; }

function ThemePicker({ value, onChange }: { value: ThemeId; onChange: (theme: ThemeId) => void }) {
  return <div className="theme-picker" role="radiogroup" aria-label="Цветовая тема">{themeOptions.map((option) => <button type="button" key={option.id} className={`theme-option ${value === option.id ? "selected" : ""}`} aria-checked={value === option.id} role="radio" data-tooltip={option.label} onClick={() => onChange(option.id)}><span className="theme-swatch" style={{ background: option.swatch } as CSSProperties} /><span>{option.label}</span></button>)}</div>;
}

function LanguageSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <SelectField label="Язык интерфейса" value={value} onChange={onChange} icon={<Languages size={15} />} options={[{value:"auto",label:"Системный"},{value:"ru",label:"Русский"},{value:"en-US",label:"English"}]} />;
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
  const item = compatibility.authOverride ? { title: "Auth override включён", description: "Используется тестовый сервер авторизации.", action: undefined } : compatibility.intelDegradation ? { title: "Проверьте процессор Intel", description: "13/14-е поколения могут быть нестабильны при запуске игры.", action: "dismissIntelDegradation" as const } : compatibility.rosetta ? { title: "Запуск через Rosetta", description: "Доступна нативная сборка для Apple Silicon.", action: "dismissRosetta" as const } : compatibility.earlyAccess ? { title: "Space Station 14 — ранний доступ", description: "Некоторые функции игры ещё меняются.", action: "dismissEarlyAccess" as const } : null;
  if (!item) return null;
  return <div className="compatibility-banner"><AlertTriangle size={17} /><div><strong>{item.title}</strong><span>{item.description}</span></div>{item.action && <button className="ghost-button" onClick={() => void dismiss(item.action)}>Больше не показывать</button>}</div>;
}

function EmptyState({ icon, title, description, action, onAction }: { icon: React.ReactNode; title: string; description: string; action: string; onAction: () => void }) { return <div className="empty-state"><div className="empty-icon">{icon}</div><h2>{title}</h2><p>{description}</p><button className="secondary-button" onClick={onAction}>{action} <ArrowRight className="action-arrow" size={14} /></button></div>; }
function InlineError({ message, onClose }: { message: string; onClose: () => void }) { return <div className="inline-error"><AlertTriangle size={16} /><span>{message}</span><button onClick={onClose} aria-label="Закрыть"><X size={15} /></button></div>; }
function FatalError({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="fatal-screen"><div className="fatal-icon"><AlertTriangle size={28} /></div><h1>Mados Launcher не запустился</h1><p>{message}</p><button className="primary-button" onClick={onRetry}><RefreshCw size={17} /> Повторить</button></div>; }
function LoadingScreen({ startupState }: { startupState?: StartupState }) {
  const labels: Record<StartupState["stage"], string> = { "starting-worker": "Запускаем worker…", "checking-data": "Проверяем данные…", "loading-ui": "Загружаем интерфейс…", ready: "Готово" };
  const stage = startupState?.stage ?? "starting-worker";
  return <div className="loading-screen"><div className="loading-brand"><CatMark large /><div><strong>Mados Launcher</strong><span>Подготавливаем рабочее пространство</span></div></div><div className="loading-status"><LoaderCircle size={19} className={stage === "ready" ? "" : "spin"} /><span>{startupState?.message ?? labels[stage]}</span></div><div className="loading-progress" aria-label={labels[stage]}><span className={stage === "ready" ? "complete" : ""} /></div></div>;
}
async function openContentBundle() { const path = await window.mados.pickContentBundle(); if (path) await window.mados.invoke("content.openBundle", { path }); }

function NotificationToast({ notification, onClose, onOpen }: { notification: LauncherNotification; onClose: () => void; onOpen: () => void }) {
  const tone = notificationTone(notification.kind);
  return <div className={`notification-toast ${tone}`} role="status"><span className="notification-toast-icon">{tone === "success" ? <CheckCircle2 size={17} /> : <Bell size={17} />}</span><button className="notification-toast-copy" onClick={onOpen}><strong>{notification.title}</strong><span>{notification.message}</span></button><button className="notification-toast-close" aria-label="Закрыть уведомление" onClick={onClose}><X size={15} /></button></div>;
}

function NotificationJournal({ notifications, onRead, onClear, onClose }: { notifications: LauncherNotification[]; onRead: (notification: LauncherNotification) => void; onClear: () => void; onClose: () => void }) {
  return <aside className="notification-journal" aria-label="Журнал уведомлений"><div className="notification-journal-head"><div><p className="eyebrow">События лаунчера</p><h2>Уведомления</h2></div><div className="modal-header-actions"><button className="icon-button" aria-label="Очистить уведомления" data-tooltip="Очистить" disabled={notifications.length === 0} onClick={onClear}><Trash2 size={16} /></button><button className="icon-button" aria-label="Закрыть уведомления" onClick={onClose}><X size={17} /></button></div></div>{notifications.length === 0 ? <div className="notification-empty"><Bell size={22} /><strong>Здесь пока пусто</strong><span>Новые события появятся после обновлений и возвращения избранных серверов.</span></div> : <div className="notification-list">{notifications.map((notification) => <button key={notification.id} className={`notification-item ${notification.readAt ? "read" : "unread"}`} onClick={() => onRead(notification)}><span className={`notification-item-icon ${notificationTone(notification.kind)}`}>{notification.kind === "favorite-online" ? <Wifi size={15} /> : <Bell size={15} />}</span><span className="notification-item-copy"><strong>{notification.title}</strong><span>{notification.message}</span><time dateTime={notification.createdAt}>{formatDurationSince(notification.createdAt)}</time></span>{!notification.readAt && <span className="notification-unread-dot" />}</button>)}</div>}</aside>;
}

function handleWorkerEvent(event: WorkerEvent, setState: Dispatch<SetStateAction<LauncherState | null>>, setSettings: Dispatch<SetStateAction<LauncherSettings | null>>, setConnection: Dispatch<SetStateAction<LaunchActivity | null>>, setStartupError: Dispatch<SetStateAction<string | null>>, setShellUpdate: Dispatch<SetStateAction<ShellUpdate>>) {
  if (event.event === "app.ready") setState(event.data as LauncherState);
  if (event.event === "auth.changed") { const data = event.data as { accounts: Account[]; activeAccount: Account | null; favorites?: Favorite[] }; setState((current) => ({ ...(current as LauncherState), accounts: data.accounts, activeAccount: data.activeAccount, favorites: data.favorites ?? (current as LauncherState).favorites, loggedIn: data.activeAccount != null })); }
  if (event.event === "settings.changed") {
    const data = event.data as { discord?: { enabled: boolean; showNickname: boolean }; favoriteAvailabilityNotifications?: boolean };
    if (data.discord) setSettings((current) => current ? { ...current, discordPresenceEnabled: data.discord!.enabled, discordPresenceShowNickname: data.discord!.showNickname } : current);
    if (typeof data.favoriteAvailabilityNotifications === "boolean") setSettings((current) => current ? { ...current, favoriteAvailabilityNotifications: data.favoriteAvailabilityNotifications! } : current);
  }
  if (event.event.startsWith("connection.") || event.event.startsWith("update.")) setConnection(current => reduceLaunchEvent(current, event));
  if (event.event === "app.error") setStartupError("Worker initialization failed");
  if (event.event === "shell.updateState") {
    const next = event.data as ShellUpdate;
    setShellUpdate(current => next.revision >= current.revision ? next : current);
  }
}

