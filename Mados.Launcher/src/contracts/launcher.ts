export type WorkerError = {
  code: string;
  message: string;
  details?: unknown;
};

export type WorkerEvent = {
  v: 1;
  event: string;
  data: unknown;
};

export type PresenceState = "launcher" | "connecting" | "updating" | "playing";

export type PresenceSnapshot = {
  state: PresenceState;
  enabled: boolean;
  showNickname: boolean;
  accountName: string | null;
  serverName: string | null;
  address: string | null;
  playerCount: number | null;
  softMaxPlayerCount: number | null;
  pingMs: number | null;
  map: string | null;
  mode: string | null;
  startedAt: string | null;
};

export type DiscordPresenceStatus = "connected" | "unavailable" | "disabled";

export type WorkerResponse<T = unknown> = {
  v: 1;
  id: string;
  result?: T;
  error?: WorkerError;
};

export type Account = {
  id: string;
  username: string | null;
  status: "unsure" | "available" | "expired" | string;
  active: boolean;
};

export type Favorite = {
  name: string | null;
  address: string;
  raiseTime: string;
};

export type ServerNote = {
  address: string;
  text: string;
  updatedAt: string;
};

export type Server = {
  address: string;
  name: string | null;
  playerCount: number;
  softMaxPlayerCount: number;
  roundStartTime: string | null;
  runLevel: string | null;
  tags: string[];
  status: "online" | "offline" | "fetching" | string;
  hubAddress: string;
  pingMs?: number | null;
  language?: string | null;
  map?: string | null;
  mode?: string | null;
};

export type ServerDetails = {
  name?: string | null;
  description?: string | null;
  links?: Array<{ name: string; icon?: string | null; url: string }>;
  status?: "online" | "offline" | string;
  playerCount?: number | null;
  softMaxPlayerCount?: number | null;
  pingMs?: number | null;
  map?: string | null;
  mode?: string | null;
};

export type LauncherState = {
  ready: boolean;
  loggedIn: boolean;
  activeAccount: Account | null;
  accounts: Account[];
  favorites: Favorite[];
  version: string;
  discord?: {
    enabled: boolean;
    showNickname: boolean;
  };
  compatibility?: {
    outOfDate: boolean;
    earlyAccess: boolean;
    intelDegradation: boolean;
    rosetta: boolean;
    authOverride: boolean;
  };
};

export type ServerListResult = {
  servers: Server[];
  failedHubs: string[];
  partialError: boolean;
};

export type Settings = {
  compatMode: boolean;
  verboseLogging: boolean;
  overrideAssets: boolean;
  language: string | null;
  multiAccounts: boolean;
  accountManagementUrl: string;
  registerUrl: string;
  discordUrl: string;
  websiteUrl: string;
  discordPresenceEnabled: boolean;
  discordPresenceShowNickname: boolean;
  favoriteAvailabilityNotifications: boolean;
};

export type NewsItem = {
  title: string;
  link: string;
  date?: string | null;
  source?: string | null;
  summary?: string | null;
};

export type ConnectionProgress = {
  status: string;
  reason?: string | null;
  privacyPolicy?: { link: string; identifier: string; version: string } | null;
  progress?: { downloaded?: number; total?: number; unit?: string } | number | null;
};

export type PlaytimePeriod = "all" | "today" | "sevenDays";

export type PlaytimeSummary = {
  accountId: string | null;
  period: PlaytimePeriod;
  trackedSince: string | null;
  totalSeconds: number;
  sessionCount: number;
  uniqueServers: number;
  activeSession: {
    address: string;
    name: string | null;
    startedAt: string;
    elapsedSeconds: number;
  } | null;
  servers: Array<{
    address: string;
    name: string | null;
    totalSeconds: number;
    sessionCount: number;
    lastPlayedAt: string | null;
    active: boolean;
  }>;
};

export type RecentConnection = {
  address: string;
  name: string | null;
  lastConnectedAt: string;
  playerCount: number | null;
  pingMs: number | null;
};

export type FavoriteMonitorSample = {
  capturedAt: string;
  isOnline: boolean;
  pingMs: number | null;
  playerCount: number | null;
};

export type FavoriteMonitorSummary = {
  address: string;
  name: string | null;
  isOnline: boolean;
  playerCount: number | null;
  softMaxPlayerCount: number | null;
  pingMs: number | null;
  pingDeltaMs: number | null;
  playerDelta: number | null;
  samples: FavoriteMonitorSample[];
};

export type LaunchProfile = {
  id: string;
  address: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type LauncherNotification = {
  id: string;
  kind: "favorite-online" | "launcher-update" | "game-update";
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
};

/** A build published by Robust.Cdn, or a directly supplied server archive. */
export type CdnBuildVariant = {
  id: string;
  version: string | null;
  platform: "windows" | "macos" | "linux" | string;
  architecture: "x64" | "arm64" | string;
  downloadUrl: string;
  sizeBytes: number | null;
  publishedAt: string | null;
};

export type CdnInspection = {
  sourceUrl: string;
  sourceType: "robust-cdn" | "zip";
  builds: CdnBuildVariant[];
  recommendedBuildId: string | null;
};

export type CdnImportRequest = {
  operationId: string;
  sourceUrl?: string;
  localPath?: string;
  buildId?: string;
  profileName?: string;
  profileId?: string;
};

export type CdnProgress = {
  operationId: string;
  stage: "inspecting" | "downloading" | "extracting" | "validating" | "completed" | "failed" | "cancelled";
  percent: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  message: string | null;
};

export type LocalServerStatus =
  | "idle"
  | "downloading"
  | "extracting"
  | "ready"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export type LocalServerProfile = {
  id: string;
  name: string;
  sourceUrl: string | null;
  installPath: string;
  version: string | null;
  platform: string;
  architecture: string;
  port: number;
  bindAddress: string;
  dataPath: string;
  configPath: string;
  createdAt: string;
  updatedAt: string;
  lastStartedAt: string | null;
};

export type LocalServerCreateInput = CdnImportRequest;

export type LocalServerUpdateInput = {
  name?: string;
  port?: number;
  bindAddress?: "127.0.0.1";
};

export type LocalServerBackup = {
  id: string;
  profileId: string;
  createdAt: string;
  reason: string;
};

export type StartupState = {
  stage: "starting-worker" | "checking-data" | "loading-ui" | "ready";
  message?: string;
};

export type LocalServerSnapshot = {
  profileId: string | null;
  status: LocalServerStatus;
  pid: number | null;
  address: string;
  port: number;
  readyAt: string | null;
  lastError: string | null;
};

export type LocalServerConfig = {
  name: string | null;
  hostname: string | null;
  bindAddress: string;
  port: number;
  maxPlayers: number | null;
  authMode: string | null;
  rawToml: string;
};

export type LocalServerLogLine = {
  profileId: string;
  timestamp: string;
  stream: "stdout" | "stderr";
  line: string;
};

export type PortTestResult = {
  address: string;
  port: number;
  available: boolean;
  error: string | null;
};

export type LauncherApi = {
  invoke<T = unknown>(method: string, params?: unknown): Promise<T>;
  serverNotes: {
    list(): Promise<ServerNote[]>;
    upsert(address: string, text: string): Promise<ServerNote | null>;
    remove(address: string): Promise<{ removed: boolean }>;
  };
  monitoring: {
    getFavorites(): Promise<{ accountId: string; favorites: FavoriteMonitorSummary[] }>;
    refresh(): Promise<{ accountId: string; favorites: FavoriteMonitorSummary[] }>;
  };
  launchProfiles: {
    list(): Promise<LaunchProfile[]>;
    create(name: string, address: string): Promise<LaunchProfile>;
    update(id: string, name: string, address: string): Promise<LaunchProfile>;
    remove(id: string): Promise<{ removed: boolean }>;
    use(id: string): Promise<LaunchProfile>;
  };
  notifications: {
    list(): Promise<LauncherNotification[]>;
    markRead(id: string): Promise<{ marked: boolean }>;
    clear(): Promise<{ removed: number }>;
  };
  tools: {
    cdnInspect(sourceUrl: string): Promise<CdnInspection>;
    cdnImport(request: CdnImportRequest): Promise<{ operationId: string; profile: LocalServerProfile }>;
    cdnCancel(operationId: string): Promise<{ cancelled: boolean }>;
  };
  localServers: {
    list(): Promise<LocalServerProfile[]>;
    create(input: LocalServerCreateInput): Promise<{ operationId: string; profile: LocalServerProfile }>;
    update(id: string, input: LocalServerUpdateInput): Promise<LocalServerProfile>;
    remove(id: string): Promise<{ removed: boolean }>;
    start(id: string): Promise<LocalServerSnapshot>;
    stop(id: string): Promise<LocalServerSnapshot>;
    restart(id: string): Promise<LocalServerSnapshot>;
    getStatus(id?: string): Promise<LocalServerSnapshot>;
    getConfig(id: string): Promise<LocalServerConfig>;
    saveConfig(id: string, config: LocalServerConfig, mode: "fields" | "raw"): Promise<LocalServerConfig>;
    testPort(port: number, bindAddress?: string): Promise<PortTestResult>;
    openFolder(id: string): Promise<{ opened: boolean }>;
    openLog(id: string): Promise<{ opened: boolean }>;
    saveLog(id: string): Promise<{ saved: boolean }>;
    backups(id: string): Promise<LocalServerBackup[]>;
    rollback(id: string, backupId: string): Promise<LocalServerProfile>;
  };
  pickLocalServerArchive(): Promise<string | null>;
  getStartupState(): Promise<StartupState>;
  onStartupState(listener: (state: StartupState) => void): () => void;
  onEvent(listener: (event: WorkerEvent) => void): () => void;
  onDiscordStatus(listener: (status: { status: DiscordPresenceStatus }) => void): () => void;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  openExternal(url: string): Promise<void>;
  pickContentBundle(): Promise<string | null>;
  getPathForFile(file: File): string;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  installUpdate(): void;
};

declare global {
  interface Window {
    mados: LauncherApi;
  }
}
