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
};

export type ServerDetails = {
  description?: string | null;
  links?: Array<{ name: string; icon?: string | null; url: string }>;
};

export type LauncherState = {
  ready: boolean;
  loggedIn: boolean;
  activeAccount: Account | null;
  accounts: Account[];
  favorites: Favorite[];
  version: string;
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

export type LauncherApi = {
  invoke<T = unknown>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (event: WorkerEvent) => void): () => void;
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
