import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, MouseEvent, ReactNode, SetStateAction } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  CheckCircle2,
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
import { type CommandAction } from "./CommandPalette";
import { LauncherSearch } from "./LauncherSearch";
import { SettingsView } from "./SettingsView";
import type { SettingSearchRequest } from "./settings-search";
import { LaunchProfiles, type ProfileLoadState } from "./LaunchProfiles";
import { useLaunchProfiles } from "./useLaunchProfiles";
import { FavoriteCollection } from "./FavoriteCollection";
import { ViewState, LoadingCards } from "./ViewState";
import { LauncherGuide, useLauncherGuide } from "./LauncherGuide";
import type { LaunchProfileDraft } from "./launch-profiles";
import { ToolsView } from "./ToolsView";
import { LastServerCard } from "./LastServerCard";
import { PlaytimeView } from "./PlaytimeView";
import { NotificationCenter, useNotifications } from "./NotificationCenter";
import { ServerDetailsPanel } from "./ServerDetailsPanel";
import { CacheTransferNotice } from "./CacheTransferCard";
import { SeatWatchPanel } from "./SeatWatchPanel";
import { LaunchDock } from "./LaunchDock";
import { HomeDashboard } from "./HomeDashboard";
import { AccountSwitcher } from "./AccountSwitcher";
import { beginAccountTransition } from "./account-transition";
import { useLauncherTheme } from "./ThemePicker";
import { SessionRecap, WeeklyPlaytime } from "./HomePlaytime";
import { LauncherUpdateView } from "./LauncherUpdateView";
import { NewsView } from "./NewsView";
import { reduceLaunchEvent, type LaunchActivity } from "./launch-status";

import { ConfirmProvider, useConfirm } from "./ConfirmDialog";
import { ServerMark } from "./ServerMark";
import { queueServerHandoff } from "./server-handoff";
import { TooltipLayer } from "./TooltipLayer";
import { SelectField } from "./SelectField";

type Tab = "home" | "servers" | "news" | "playtime" | "tools" | "settings";
type CatalogTool = "favorites" | "monitoring" | "profiles" | "direct";
type RequestError = Error & { code?: string; details?: { errors?: string[] } };
type ShellUpdate = ShellUpdateState;

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
  const guide = useLauncherGuide(Boolean(state?.loggedIn && state?.activeAccount?.status !== "expired"));
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
  const [diagnosticRequest,setDiagnosticRequest]=useState<{address:string;revision:number}|null>(null);
  const consumedDiagnostic=useRef<number|null>(null);
  const themeController = useLauncherTheme();
  const [accountLoginAccount, setAccountLoginAccount] = useState<Account | null>(null);
  const loginWasOpen = useRef(false);
  useEffect(() => {
    if (loginWasOpen.current && !accountLoginOpen) document.querySelector<HTMLButtonElement>('[aria-label="Аккаунты"]')?.focus({ preventScroll: true });
    loginWasOpen.current = accountLoginOpen;
  }, [accountLoginOpen]);
  const [discordStatus, setDiscordStatus] = useState<DiscordPresenceStatus>("unavailable");
  const notificationFeed = useNotifications(state?.activeAccount?.id);
  const { items: notifications, toast } = notificationFeed;
  const [notificationServer, setNotificationServer] = useState<Server | null>(null);
  const [settingsSearchRequest, setSettingsSearchRequest] = useState<SettingSearchRequest | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const profileController = useLaunchProfiles(state?.activeAccount?.id, confirm);
  const { profiles, busy: profilesBusy, create: createProfile, update: updateProfile, remove: removeProfile, useProfile, status: profileStatus } = profileController;


  useEffect(() => { setNotificationsOpen(false); setNotificationServer(null); setPaletteOpen(false); setDiagnosticRequest(null); }, [state?.activeAccount?.id]);
  const openNotification = (item: LauncherNotification) => {
    setNotificationsOpen(false);
    if (item.id !== "current-update") void notificationFeed.read(item);
    if (item.kind === "launcher-update") { setSettingsSearchRequest(value => ({id:"updates", revision:(value?.revision ?? 0)+1})); setTab("settings"); }
    else if ((item.kind === "favorite-online" || item.kind === "server-slot") && item.address) {
      setNotificationServer(serverFromRecentConnection({address:item.address,name:item.message,lastConnectedAt:item.createdAt,playerCount:null,pingMs:null}));
    } else setTab("servers");
  };

  useEffect(() => {
    const language = settings?.language?.toLowerCase();
    document.documentElement.lang = language?.startsWith("en") ? "en" : "ru";
    document.documentElement.classList.toggle("reduce-motion", localStorage.getItem("mados.reducedMotion") === "true");
  }, [settings]);

  useEffect(() => {
    const startupApi = window.mados as typeof window.mados & { onStartupState?: (listener: (state: StartupState) => void) => () => void; getStartupState?: () => Promise<StartupState> };
    const unsubscribeStartup = startupApi.onStartupState?.((next) => setStartupState(next)) ?? (() => undefined);
    const startupPromise = startupApi.getStartupState?.();
    if (startupPromise) void startupPromise.then(setStartupState).catch(() => undefined);
    const unsubscribe = window.mados.onEvent((event) => handleWorkerEvent(event, setState, setSettings, setConnection, setStartupError, setShellUpdate));
    void window.mados.getUpdateState?.().then(next => setShellUpdate(current => next.revision >= current.revision ? next : current)).catch(() => undefined);
    const unsubscribeDiscord = window.mados.onDiscordStatus(({ status }) => setDiscordStatus(status));
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    const onLauncherError = (event: Event) => setStartupError((event as CustomEvent<{ message: string }>).detail.message);
    const onDragOver = (event: DragEvent) => { if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return; event.preventDefault(); setDragActive(!(event.target instanceof Element && event.target.closest(".replay-library"))); };
    const onDragLeave = (event: DragEvent) => { if (event.target === event.currentTarget) setDragActive(false); };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragActive(false);
      if(event.target instanceof Element && event.target.closest(".replay-library"))return;
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
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("launcher-error", onLauncherError);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const executePaletteAction = useCallback(async (action: CommandAction) => {
    if (action.type === "open-setting") {
      setSettingsSearchRequest(value => ({id:action.settingId, revision:(value?.revision ?? 0)+1}));
      setTab("settings");return;
    }
    if (action.type === "open-server") { setNotificationServer(action.server);return; }
    if (action.type === "navigate") {
      setTab(action.tab);
      return;
    }
    if (action.type === "refresh-servers") {
      setTab("servers");
      try { await window.mados.invoke("servers.refresh"); } catch(caught) { setStartupError((caught as Error).message); }
      return;
    }
    if (action.type === "open-monitoring") {
      setTab("servers");
      setCatalogTool("monitoring");
      return;
    }
    if (action.type === "connect-profile") {
      try {
        await profileController.launch(action.profileId);
      } catch(caught) { setStartupError((caught as Error).message); }
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

  const openSearch = useCallback(() => {
    if (document.querySelector('[role="alertdialog"], .login-overlay, .launcher-guide')) return;
    window.dispatchEvent(new Event("launcher-search-opened"));
    setNotificationsOpen(false);setNotificationServer(null);setPaletteOpen(true);
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (paletteOpen) setPaletteOpen(false); else openSearch();
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setNotificationsOpen(false);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [paletteOpen, openSearch]);

  if (startupError && !state) {
    return <FatalError message={startupError} onRetry={() => window.location.reload()} />;
  }

  if (!state) {
    return <LoadingScreen startupState={startupState} />;
  }

  if (!state.loggedIn || state.activeAccount?.status === "expired") {
    return <><LoginScreen initialUsername={state.activeAccount?.username ?? undefined} onLoggedIn={setState} expired={state.activeAccount?.status === "expired"} /><div className="login-update-notice"><LauncherUpdateView update={shellUpdate} /></div></>;
  }

  return (
    <div className="app-shell">
      {guide.open && <LauncherGuide onClose={guide.close}/>}
      <TitleBar notificationPulse={toast?.id} unreadNotifications={notificationUnreadCount(notifications)} onToggleNotifications={() => setNotificationsOpen((open) => !open)} onOpenPalette={openSearch} />
      <div className="app-layout">
        <Sidebar state={state} tab={tab} setTab={setTab} onStateChange={setState} onAddAccount={() => { setAccountLoginAccount(null); setAccountLoginOpen(true); }} onReauthenticate={account => { setAccountLoginAccount(account); setAccountLoginOpen(true); }} />
        <main className="main-content">
          <div className="content-scroll">
            <div className="global-status-stack">
              {!online && <ViewState compact kind="offline" icon={<WifiOff size={20}/>} title="Сейчас вы офлайн" description="Сохранённые серверы и локальные данные доступны. Сетевые действия заработают после восстановления связи."/>}
              {state.compatibility && <CompatibilityBanner state={state} onStateChange={setState} />}
              {guide.error && <InlineError message={guide.error} onClose={guide.clearError}/>}
              {startupError && <InlineError message={startupError} onClose={() => setStartupError(null)} />}
              <LauncherUpdateView update={shellUpdate} onOpenDetails={() => { setSettingsSearchRequest(value => ({id:"updates",revision:(value?.revision ?? 0)+1})); setTab("settings"); }} launchBusy={Boolean(connection && !["ClientExited", "Cancelled", "ConnectionFailed", "UpdateError", "NotAContentBundle", "Error"].includes(connection.status))} />
            </div>
            {tab === "home" && <HomeView onOpenGuide={() => guide.setOpen(true)} playing={connection?.status === "ClientRunning"} launchBusy={Boolean(connection && !["Cancelled", "ConnectionFailed", "UpdateError", "NotAContentBundle", "Error"].includes(connection.status))} state={state} onNavigate={setTab} onManageFavorites={() => {setTab("servers");setCatalogTool("favorites");}} onStateChange={next=>setState(current=>current?.activeAccount?.id===next.activeAccount?.id?next:current)} profiles={profiles} profilesBusy={profilesBusy} profileStatus={profileStatus} onUseProfile={useProfile} onCreateProfile={createProfile} onUpdateProfile={updateProfile} onRemoveProfile={removeProfile} />}
            {tab === "servers" && <ServersView state={state} key={state.activeAccount?.id} tool={catalogTool} onToolChange={setCatalogTool} onStateChange={next=>setState(current=>current?.activeAccount?.id===next.activeAccount?.id?next:current)} profiles={profiles} profilesBusy={profilesBusy} profileStatus={profileStatus} onUseProfile={useProfile} onCreateProfile={createProfile} onUpdateProfile={updateProfile} onRemoveProfile={removeProfile} />}
            {tab === "news" && <NewsView accountId={state.activeAccount!.id} update={shellUpdate} onOpenUpdate={() => { setSettingsSearchRequest(value => ({id:"updates",revision:(value?.revision ?? 0)+1})); setTab("settings"); }} />}
            {tab === "playtime" && <PlaytimeView key={state.activeAccount?.id} accountId={state.activeAccount!.id} username={state.activeAccount!.username} onBrowse={() => setTab("servers")} />}
            {tab === "tools" && <ToolsView key={state.activeAccount?.id} accountId={state.activeAccount?.id} diagnosticRequest={diagnosticRequest} autoDiagnose={!!diagnosticRequest&&consumedDiagnostic.current!==diagnosticRequest.revision} onDiagnosticStarted={()=>{consumedDiagnostic.current=diagnosticRequest?.revision??null;}} onDiagnosticLogin={()=>{setAccountLoginAccount(state.activeAccount);setAccountLoginOpen(true);}} onError={setStartupError} launchProfiles={profiles} launchProfilesBusy={profilesBusy} profileStatus={profileStatus} onUseLaunchProfile={useProfile} onCreateLaunchProfile={createProfile} onUpdateLaunchProfile={updateProfile} onRemoveLaunchProfile={removeProfile} />}
            {tab === "settings" && <SettingsView request={settingsSearchRequest} settings={settings} setSettings={setSettings} themeController={themeController} discordStatus={discordStatus} shellUpdate={shellUpdate} launchBusy={Boolean(connection && !["ClientExited", "Cancelled", "ConnectionFailed", "UpdateError", "NotAContentBundle", "Error"].includes(connection.status))} />}
          </div>
          <CacheTransferNotice/>
          <SeatWatchPanel key={`seat-${state.activeAccount?.id}`} compact accountId={state.activeAccount?.id}/>
          {connection && <LaunchDock activity={connection} onDismiss={() => setConnection(null)} onDiagnose={connection.address?()=>{setDiagnosticRequest({address:connection.address!,revision:Date.now()});setTab("tools");}:undefined} onOpenServer={connection.address&&!connection.contentBundle?()=>setNotificationServer(serverFromRecentConnection({address:connection.address!,name:connection.name,lastConnectedAt:new Date().toISOString(),playerCount:null,pingMs:null})):undefined} />}
          {state.activeAccount && <SessionRecap key={state.activeAccount.id} accountId={state.activeAccount.id} launchBusy={Boolean(connection)} onOpenPlaytime={() => setTab("playtime")} />}
        </main>
      </div>
      {dragActive && <div className="drop-overlay"><div className="drop-card"><Download size={28} /><strong>Отпустите .zip здесь</strong><span>Контент-бандл или реплей откроется через C# worker</span></div></div>}
      {accountLoginOpen && <LoginScreen mode="add" initialUsername={accountLoginAccount?.username ?? undefined} expired={Boolean(accountLoginAccount)} onLoggedIn={(next) => { setState(next); setAccountLoginOpen(false); }} onCancel={() => setAccountLoginOpen(false)} />}
      {notificationsOpen && <NotificationCenter key={state.activeAccount?.id} {...notificationFeed} accountId={state.activeAccount!.id} onClose={() => setNotificationsOpen(false)} onAction={openNotification} update={shellUpdate} />}
      {toast && <NotificationToast key={toast.id} notification={toast} onClose={notificationFeed.dismissToast} onOpen={() => { setNotificationsOpen(true); notificationFeed.dismissToast(); }} />}
      {notificationServer && <ServerDetailsPanel key={`${state.activeAccount?.id}:${notificationServer.address}`} accountId={state.activeAccount?.id} server={notificationServer} onClose={() => setNotificationServer(null)} onConnect={() => { const server=notificationServer;setNotificationServer(null);void window.mados.invoke("servers.connect", {address:server.address,name:server.name}).catch((error:Error)=>setStartupError(error.message)); }} />}
      {paletteOpen && <LauncherSearch key={state.activeAccount?.id} state={state} hasLastServer={Boolean(localStorage.getItem(lastServerStorageKey(state.activeAccount?.id)))} onClose={() => setPaletteOpen(false)} onExecute={action => { void executePaletteAction(action); }} />}
    </div>
  );
}

function TitleBar({ notificationPulse, unreadNotifications, onToggleNotifications, onOpenPalette }: { notificationPulse?: string; unreadNotifications: number; onToggleNotifications: () => void; onOpenPalette: () => void }) {
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
        <button className="title-action notification-trigger" aria-label="Уведомления" data-tooltip="Уведомления" onClick={onToggleNotifications}><Bell key={notificationPulse ?? "quiet"} size={15} className={notificationPulse ? "notification-arrived" : ""} />{unreadNotifications > 0 && <span className="notification-badge">{unreadNotifications > 9 ? "9+" : unreadNotifications}</span>}</button>
        <button aria-label="Свернуть" onClick={() => window.mados.minimize()}><Minimize2 size={15} /></button>
        <button aria-label={maximized ? "Восстановить" : "Развернуть"} onClick={() => window.mados.toggleMaximize()}>{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
        <button aria-label="Закрыть" className="close-control" onClick={() => window.mados.close()}><X size={16} /></button>
      </div>
    </header>
  );
}

function Sidebar({ state, tab, setTab, onStateChange, onAddAccount, onReauthenticate }: { state: LauncherState; tab: Tab; setTab: (tab: Tab) => void; onStateChange: (state: LauncherState) => void; onAddAccount: () => void; onReauthenticate: (account: Account) => void }) {
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
        <AccountSwitcher state={state} onStateChange={onStateChange} onAddAccount={onAddAccount} onReauthenticate={onReauthenticate} />
        <div className="sidebar-version">Mados Launcher · {state.version}</div>
      </div>
    </aside>
  );
}

function HomeView({ onOpenGuide, playing, launchBusy, state, onNavigate, onManageFavorites, onStateChange, profiles, profilesBusy, profileStatus, onUseProfile, onCreateProfile, onUpdateProfile, onRemoveProfile }: { onOpenGuide: () => void; playing: boolean; launchBusy: boolean; state: LauncherState; onNavigate: (tab: Tab) => void; onManageFavorites: () => void; onStateChange: (state: LauncherState) => void; profiles: LaunchProfile[]; profilesBusy: boolean; profileStatus: ProfileLoadState; onUseProfile: (profile: LaunchProfile) => void | Promise<void>; onCreateProfile: (draft: LaunchProfileDraft) => void | Promise<void>; onUpdateProfile: (id: string, draft: LaunchProfileDraft) => void | Promise<void>; onRemoveProfile: (profile: LaunchProfile) => void | Promise<void> }) {
  const [lastServer, setLastServer] = useState<Server | null>(null);
  const [selectedHomeServer, setSelectedHomeServer] = useState<Server | null>(null);
  const [busy, setBusy] = useState(false);
  const [recentConnections, setRecentConnections] = useState<RecentConnection[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recentRetry, setRecentRetry] = useState(0);
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
  }, [state.activeAccount?.id, recentRetry]);
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
      <div className="page-heading"><div><p className="eyebrow">Добро пожаловать обратно</p><h1>{state.activeAccount?.username ?? "Mados"}</h1><p className="page-subtitle">Готовы вернуться на станцию?</p></div><div className="heading-actions"><button className="icon-button" aria-label="Справка" data-tooltip="Краткий гайд по лаунчеру" onClick={onOpenGuide}><CircleHelp size={18} /></button></div></div>
      {favoriteError && <InlineError message={favoriteError} onClose={() => setFavoriteError(null)} />}
      <HomeDashboard key={state.activeAccount?.id ?? "anonymous"} accountId={state.activeAccount?.id ?? "anonymous"} favorites={state.favorites} renderBlocks={homeFavorites => ({
        lastServer: (<LastServerCard key={`${state.activeAccount?.id}:${recentConnections[0]?.address ?? lastServer?.address ?? "empty"}`} accountId={state.activeAccount?.id}
        server={recentConnections[0] ? serverFromRecentConnection(recentConnections[0]) : lastServer} recent={recentConnections[0]}
        loading={recentLoading} playing={playing} busy={busy || launchBusy} onConnect={server => void connect(server)} onBrowse={() => onNavigate("servers")} onDetails={setSelectedHomeServer} />),
        recent: (<><div className="section-heading"><div><h2>Недавние подключения</h2><span>{recentConnections.length} серверов</span></div><button className="ghost-button" onClick={() => onNavigate("servers")}>Каталог <ArrowRight className="action-arrow" size={15} /></button></div>
      {recentError && <ViewState compact kind="error" title="История подключений недоступна" description={recentError} action="Повторить" onAction={()=>setRecentRetry(value=>value+1)}/>}
      {recentLoading ? <LoadingCards count={3} className="recent-connection-grid" itemClassName="recent-connection-skeleton" label="Загружаем недавние подключения…"/> : recentConnections.length > 0 ? <div className="recent-connection-grid">{sortRecentConnections(recentConnections, "recent").map((recent) => <RecentConnectionCard key={recent.address} connection={recent} onConnect={() => void connect(serverFromRecentConnection(recent))} onDetails={() => setSelectedHomeServer(serverFromRecentConnection(recent))} />)}</div> : recentError ? null : <EmptyState icon={<Clock3 size={23} />} title="Недавних подключений пока нет" description="Подключитесь к серверу, и он появится здесь после успешного запуска игры." action="Открыть каталог" onAction={() => onNavigate("servers")} />}</>),
        favorites: (<><div className="section-heading"><div><h2>Избранные серверы</h2><span>{state.favorites.length} сохранено</span></div><button className="ghost-button" onClick={onManageFavorites}>Моя коллекция <ArrowRight className="action-arrow" size={15} /></button></div>
      {state.favorites.length > 0 ? <div className="favorite-grid">{homeFavorites.slice(0, 4).map((favorite) => <FavoriteCard key={favorite.address} favorite={favorite} onConnect={() => void connect(serverFromFavorite(favorite))} onRemove={() => void removeFavorite(favorite)} onDetails={() => setSelectedHomeServer(serverFromFavorite(favorite))} />)}</div> : <EmptyState icon={<Star size={23} />} title="Избранных серверов пока нет" description="Сохраните серверы, к которым возвращаетесь чаще всего." action="Открыть каталог" onAction={() => onNavigate("servers")} />}</>),
        quickActions: (<div className="quick-actions"><button className="quick-action" onClick={() => onNavigate("servers")}><Globe2 size={18} /><span><strong>Каталог серверов</strong><small>Найти новую станцию</small></span><ArrowRight className="action-arrow" size={16} /></button><button className="quick-action" onClick={() => void openContentBundle().catch((caught: Error) => setFavoriteError(caught.message))}><Download size={18} /><span><strong>Открыть контент-бандл</strong><small>Запустить .zip или реплей</small></span><ArrowRight className="action-arrow" size={16} /></button></div>),
        profiles: (<LaunchProfiles {...profileStatus} profiles={profiles} busy={profilesBusy} onUse={onUseProfile} onCreate={onCreateProfile} onUpdate={onUpdateProfile} onRemove={onRemoveProfile} />),
        week: (<WeeklyPlaytime accountId={state.activeAccount?.id ?? "anonymous"} onOpen={() => onNavigate("playtime")} />),
      })} />
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
  return <article data-server-address={safeAddress} className="favorite-card" role="button" tabIndex={0} aria-label={`Подробнее об избранном сервере ${favorite.name || safeAddress}`} onClick={handleCardClick} onKeyDown={handleKeyDown}><div className="favorite-card-top"><ServerMark /><span className="favorite-saved">В избранном</span><button className="favorite-star" aria-label="Удалить из избранного" onClick={(event) => { event.stopPropagation(); onRemove(); }}><Star size={16} fill="currentColor" /></button></div><h3>{favorite.name || "Без названия"}</h3><p>{safeAddress}</p><button className="card-connect" onClick={(event) => { event.stopPropagation(); queueServerHandoff(favorite.address, event.currentTarget, "launch"); onConnect(); }}>Подключиться <ArrowRight className="action-arrow" size={14} /></button></article>;
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

function ServersView({ state, tool, onToolChange, onStateChange, profiles, profilesBusy, profileStatus, onUseProfile, onCreateProfile, onUpdateProfile, onRemoveProfile }: { state: LauncherState; tool: CatalogTool | null; onToolChange: (tool: CatalogTool | null) => void; onStateChange: (state: LauncherState) => void; profiles: LaunchProfile[]; profilesBusy: boolean; profileStatus: ProfileLoadState; onUseProfile: (profile: LaunchProfile) => void | Promise<void>; onCreateProfile: (draft: LaunchProfileDraft) => void | Promise<void>; onUpdateProfile: (id: string, draft: LaunchProfileDraft) => void | Promise<void>; onRemoveProfile: (profile: LaunchProfile) => void | Promise<void> }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalogFailure, setCatalogFailure] = useState<string | null>(null);
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
    setCatalogFailure(catalogError(next));
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
    setLoading(true); setCatalogFailure(null);
    try {
      const result = await window.mados.invoke<ServerListResult>(manual ? "servers.refresh" : "servers.list");
      if (sequence !== loadSequence.current) return;
      applyCatalog(result);
    } catch (e) {
      if (sequence === loadSequence.current) {
        setCatalogFailure((e as Error).message);
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
  const findFavorite = (address: string) => {
    const key = sanitizeServerAddress(address);
    return key ? state.favorites.find(favorite => sanitizeServerAddress(favorite.address) === key) : undefined;
  };
  const toggleFavorite = async (server: Server) => {
    const existing = findFavorite(server.address);
    try {
      const favorites = await window.mados.invoke<Favorite[]>(existing ? "favorites.remove" : "favorites.add", existing ? { address: existing.address } : { address: server.address, name: server.name });
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
    {catalogFailure && <ViewState compact={servers.length>0} kind="error" title="Не удалось обновить каталог" description={catalogFailure} action="Повторить загрузку" actionId="retry-catalog" onAction={() => void load(true)}/>}
    <div ref={utilitiesRef} className="catalog-utilities" aria-label="Дополнительно в каталоге">
      <button id="catalog-favorites-toggle" className="catalog-utility-toggle" aria-expanded={tool === "favorites"} aria-controls="catalog-favorites" onClick={() => onToolChange(tool === "favorites" ? null : "favorites")}><Star size={15}/>Моя коллекция<span className="utility-count">{state.favorites.length}</span><ChevronDown size={14}/></button>
      <button id="catalog-monitoring-toggle" className="catalog-utility-toggle" aria-expanded={tool === "monitoring"} aria-controls="catalog-monitoring" onClick={() => onToolChange(tool === "monitoring" ? null : "monitoring")}><Activity size={15} />Избранное сейчас<span className="utility-count">{state.favorites.length}</span>{monitoringError && <AlertTriangle size={13} className="utility-warning" />}<ChevronDown size={14} /></button>
      <button id="catalog-profiles-toggle" className="catalog-utility-toggle" aria-expanded={tool === "profiles"} aria-controls="catalog-profiles" onClick={() => onToolChange(tool === "profiles" ? null : "profiles")}><Play size={14} />Профили<span className="utility-count">{profiles.length}</span><ChevronDown size={14} /></button>
      <button id="catalog-direct-toggle" className="catalog-utility-toggle" aria-expanded={tool === "direct"} aria-controls="catalog-direct" onClick={() => onToolChange(tool === "direct" ? null : "direct")}><TerminalSquare size={15} />По адресу<ChevronDown size={14} /></button>
      <span className="catalog-result-count">{filtered.length} {pluralize(filtered.length, "сервер", "сервера", "серверов")}</span>
    </div>
    {monitoringError && tool !== "monitoring" && <div className="catalog-monitoring-warning" role="status"><AlertTriangle size={14} /><span>{monitoringError}</span><button className="text-link" onClick={() => onToolChange("monitoring")}>Подробнее <ArrowRight size={13} /></button></div>}
    <div className="catalog-utility-panel" id="catalog-favorites" role="region" aria-labelledby="catalog-favorites-toggle" hidden={tool !== "favorites"}><FavoriteCollection accountId={state.activeAccount!.id} favorites={state.favorites} servers={servers} onConnect={server=>void connect(server)} onDetails={setSelectedServer} onRemove={async favorite=>{const favorites=await window.mados.invoke<Favorite[]>("favorites.remove",{address:favorite.address});onStateChange({...state,favorites});}} onBrowse={()=>onToolChange(null)}/></div>
    <div className="catalog-utility-panel" id="catalog-monitoring" role="region" aria-labelledby="catalog-monitoring-toggle" hidden={tool !== "monitoring"}><FavoriteMonitoring summaries={monitoring} loading={monitoringLoading} error={monitoringError} onRefresh={() => void loadMonitoring(true)} /></div>
    <div className="catalog-utility-panel" id="catalog-profiles" role="region" aria-labelledby="catalog-profiles-toggle" hidden={tool !== "profiles"}><LaunchProfiles {...profileStatus} key={state.activeAccount?.id} profiles={profiles} busy={profilesBusy} onUse={onUseProfile} onCreate={onCreateProfile} onUpdate={onUpdateProfile} onRemove={onRemoveProfile} /></div>
    <div className="catalog-utility-panel" id="catalog-direct" role="region" aria-labelledby="catalog-direct-toggle" hidden={tool !== "direct"}><div className="direct-connect"><TerminalSquare size={16} /><input aria-label="Адрес сервера" value={directAddress} onChange={(event) => setDirectAddress(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void connectDirect(); }} placeholder="ss14://адрес сервера" /><button className="primary-button" onClick={() => void connectDirect()} disabled={!directAddress.trim()}><ArrowRight size={15} />Подключиться</button></div></div>
    {loading && servers.length === 0 ? <LoadingCards count={6} className="server-grid" itemClassName="server-skeleton" label="Загружаем серверы…"/> : filtered.length > 0 ? <div className="server-grid">{filtered.map((server) => <ServerCard key={server.address} server={server} favorite={Boolean(findFavorite(server.address))} hasNote={noteAddresses.has(sanitizeServerAddress(server.address))} onConnect={() => void connect(server)} onFavorite={() => void toggleFavorite(server)} onDetails={() => setSelectedServer(server)} />)}</div> : catalogFailure && servers.length === 0 ? null : <EmptyState icon={<Search size={23} />} title="Ничего не найдено" description="Измените запрос или сбросьте фильтры." action="Сбросить фильтры" onAction={() => { setQueryInput(""); setSelectedTags([]); setOnlyPopulated(false); localStorage.removeItem("mados.serverFilters"); }} />}
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

function pluralize(value: number, one: string, few: string, many: string): string {
  const mod10 = value % 10;
  const mod100 = value % 100;
  return mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? few : many;
}

function LoginScreen({ onLoggedIn, expired = false, mode = "login", onCancel, initialUsername }: { onLoggedIn: (state: LauncherState) => void; expired?: boolean; mode?: "login" | "add"; onCancel?: () => void; initialUsername?: string }) {
  const [username, setUsername] = useState(initialUsername ?? "");
  const [password, setPassword] = useState("");
  const [tfaCode, setTfaCode] = useState("");
  const [requiresTfa, setRequiresTfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => { event.preventDefault(); if(busy)return; const finishTransition=beginAccountTransition(); setBusy(true); setError(null); try { await window.mados.invoke("auth.login", { username, password, ...(requiresTfa ? { tfaCode } : {}) }); const next = await window.mados.invoke<LauncherState>("app.getState"); onLoggedIn(next); } catch (caught) { const requestError = caught as RequestError; if (requestError.code === "TFAREQUIRED" || requestError.code === "TFA_REQUIRED") setRequiresTfa(true); setError(requestError.details?.errors?.join("\n") ?? requestError.message); } finally { finishTransition(); setBusy(false); } };
  return <div className={`login-screen ${mode === "add" ? "login-overlay" : ""}`}><div className="login-backdrop" /><div className="login-panel">{mode === "add" && onCancel && <button className="icon-button login-close" onClick={onCancel} aria-label="Закрыть"><X size={18} /></button>}<div className="login-logo"><CatMark large /><span>Mados Launcher</span></div><div className="login-copy"><p className="eyebrow">{expired ? "Возвращение в аккаунт" : mode === "add" ? "Новый профиль" : "Добро пожаловать"}</p><h1>{expired ? "Войти снова" : mode === "add" ? "Добавить аккаунт" : "Войдите в аккаунт"}</h1><p>{expired ? "Сессия истекла. Введите пароль, чтобы вернуться в аккаунт." : mode === "add" ? "Добавьте ещё один аккаунт и переключайтесь между профилями из боковой панели." : "Продолжите игру на своей станции."}</p></div><form onSubmit={submit} className="login-form"><label>Имя пользователя<input autoFocus={!initialUsername} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label><label>Пароль<input autoFocus={Boolean(initialUsername)} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>{requiresTfa && <label>Код 2FA<input inputMode="numeric" value={tfaCode} onChange={(event) => setTfaCode(event.target.value)} autoComplete="one-time-code" required /></label>}{error && <div className="form-error"><AlertTriangle size={16} /><span>{error}</span></div>}<button className="primary-button login-submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <LogIn size={18} />} {requiresTfa ? "Подтвердить вход" : expired ? "Войти снова" : mode === "add" ? "Добавить аккаунт" : "Войти"}</button></form><div className="login-links"><button onClick={() => void window.mados.openExternal("https://account.spacestation14.com/Identity/Account/Register")}>Создать аккаунт <ExternalLink size={13} /></button><button onClick={() => void window.mados.openExternal("https://account.spacestation14.com/Identity/Account/ForgotPassword")}>Забыли пароль?</button></div>{mode === "add" && onCancel && <button className="login-cancel" onClick={onCancel}>Отмена</button>}<div className="security-note"><ShieldCheck size={15} /> Данные входа обрабатываются защищённым C# worker</div></div></div>;
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

function EmptyState(props: { icon: React.ReactNode; title: string; description: string; action: string; onAction: () => void }) { return <ViewState {...props}/>; }
function InlineError({ message, onClose }: { message: string; onClose: () => void }) { return <ViewState compact kind="error" title="Не удалось выполнить действие" description={message} onDismiss={onClose}/>; }
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

