import { z } from "zod";
import {appearanceSchema,personalSections} from './personal-archive';
import type { LauncherNotification, PlaytimeSummary, ShellUpdateState } from "./launcher";

export const workerRequestSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const rendererMethodSchema = z.enum([
  "cache.info","cache.chooseFolder","cache.move","cache.cancel","app.restart",
  "replays.list","replays.chooseFile","replays.add","replays.update","replays.remove","replays.play",
  "personal.export","personal.inspect","personal.restore","personal.recovery",
  "seatWatch.get","seatWatch.start","seatWatch.stop",
  "app.getState",
  "app.getVersion",
  "app.openDeepLink",
  "app.shutdown",
  "auth.getAccounts",
  "auth.login",
  "auth.logout",
  "auth.switchAccount",
  "servers.list",
  "servers.refresh",
  "servers.info",
  "servers.connect",
  "connection.cancel",
  "connection.confirmPrivacyPolicy",
  "favorites.list",
  "favorites.add",
  "favorites.remove",
  "playtime.getSummary",
  "playtime.clear",
  "recentConnections.list",
  "serverNotes.list",
  "serverNotes.upsert",
  "serverNotes.remove",
  "monitoring.getFavorites",
  "monitoring.refresh",
  "launchProfiles.list",
  "launchProfiles.create",
  "launchProfiles.update",
  "launchProfiles.remove",
  "launchProfiles.use",
  "notifications.list",
  "notifications.markRead",
  "notifications.clear",
  "tools.cdn.inspect",
  "tools.cdn.import",
  "tools.cdn.cancel",
  "localServers.list",
  "localServers.create",
  "localServers.update",
  "localServers.remove",
  "localServers.start",
  "localServers.stop",
  "localServers.restart",
  "localServers.getStatus",
  "localServers.getConfig",
  "localServers.saveConfig",
  "localServers.testPort",
  "localServers.openFolder",
  "localServers.openLog",
  "localServers.backups",
  "localServers.rollback",
  "news.list",
  "settings.get",
  "settings.update",
  "content.openBundle",
  "updates.getStatus",
  "updates.start",
  "diagnostics.run",
  "diagnostics.openLogs",
  "storage.scan",
  "storage.preview",
  "storage.clean",
]);

export const rendererInvokeSchema = z.object({
  method: rendererMethodSchema,
  params: z.unknown().optional(),
});

// Network resolution and archive content are validated again by the worker.
// The main boundary rejects credentials, local endpoints and arbitrary paths
// before any request can cross into the process that owns the filesystem.
export const publicCdnUrlSchema = z.string().max(4096).url().refine((value) => {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false;
  if (!host.includes(".") || /(?:^|\.)(localhost|local|internal|home|lan)$/.test(host) || host.includes(":")) return false;
  if (/^[\d.]+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))) return false;
  }
  return true;
}, "Use a public HTTPS URL without credentials or query parameters");

const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const loopback = z.literal("127.0.0.1");
const port = z.number().int().min(1).max(65535);
const namedProfile = z.string().trim().min(1).max(120);
const importParams = z.object({
  operationId: z.string().uuid(),
  sourceUrl: publicCdnUrlSchema.optional(),
  localPath: z.string().min(1).max(32768).refine((value) => /\.zip$/i.test(value), "Choose a ZIP archive").optional(),
  buildId: z.string().min(1).max(4096).optional(),
  profileName: namedProfile.optional(),
  profileId: identifier.optional(),
}).strict().refine((value) => Boolean(value.sourceUrl) !== Boolean(value.localPath), "Provide exactly one archive source");
const idParams = z.object({ id: identifier }).strict();
const config = z.object({
  name: z.string().max(160).nullable(),
  hostname: z.string().max(160).nullable(),
  bindAddress: loopback,
  port,
  maxPlayers: z.number().int().min(1).max(10000).nullable(),
  authMode: z.enum(["0", "1", "2", "Optional", "Required", "Disabled"]).nullable(),
  rawToml: z.string().max(1024 * 1024),
}).strict();

export const toolsMethodParams: Record<string, z.ZodTypeAny> = {
  "cache.info":z.object({}).strict(),"cache.chooseFolder":z.object({}).strict(),"cache.cancel":z.object({}).strict(),"app.restart":z.object({}).strict(),
  "cache.move":z.object({folder:z.string().min(1).max(32768)}).strict(),
  "replays.list":z.object({}).strict(),"replays.chooseFile":z.object({}).strict(),"replays.add":z.object({path:z.string().min(1).max(32768)}).strict(),
  "replays.update":z.object({id:identifier,name:namedProfile,notes:z.string().max(4000),watched:z.boolean()}).strict(),"replays.remove":idParams,"replays.play":idParams,
  "personal.export":z.object({appearance:appearanceSchema}).strict(),"personal.inspect":z.object({}).strict(),"personal.recovery":z.object({}).strict(),
  "personal.restore":z.object({id:z.string().uuid(),sections:z.array(personalSections).min(1).max(4),appearance:appearanceSchema}).strict(),
  "seatWatch.get":z.object({}).strict(),"seatWatch.stop":z.object({}).strict(),"seatWatch.start":z.object({address:z.string().min(1).max(2048),name:z.string().max(240).optional()}).strict(),
  "diagnostics.run": z.object({address:z.string().trim().min(1).max(2048)}).strict(),
  "diagnostics.openLogs": z.object({}).strict(),
  "storage.scan": z.object({}).strict(),
  "storage.preview": z.object({ids:z.array(z.string().regex(/^(content:[1-9]\d*|log:[A-F0-9]{64})$/)).min(1).max(500)}).strict(),
  "storage.clean": z.object({planId:z.string().regex(/^[a-f0-9]{32}$/)}).strict(),
  "tools.cdn.inspect": z.object({ sourceUrl: publicCdnUrlSchema }).strict(),
  "tools.cdn.import": importParams,
  "tools.cdn.cancel": z.object({ operationId: z.string().uuid() }).strict(),
  "localServers.list": z.object({}).strict(),
  "localServers.create": importParams,
  "localServers.update": z.object({ id: identifier, name: namedProfile.optional(), port: port.optional(), bindAddress: loopback.optional() }).strict(),
  "localServers.remove": idParams,
  "localServers.start": idParams,
  "localServers.stop": idParams,
  "localServers.restart": idParams,
  "localServers.getStatus": z.object({ id: identifier.optional() }).strict(),
  "localServers.getConfig": idParams,
  "localServers.saveConfig": z.object({ id: identifier, mode: z.enum(["fields", "raw"]), config }).strict(),
  "localServers.testPort": z.object({ port, bindAddress: loopback.optional() }).strict(),
  "localServers.openFolder": idParams,
  "localServers.openLog": idParams,
  "localServers.backups": idParams,
  "localServers.rollback": z.object({ id: identifier, backupId: identifier }).strict(),
};

export function validateRendererParams(method: string, params: unknown): unknown {
  return toolsMethodParams[method]?.parse(params ?? {}) ?? params;
}

export const localServerSnapshotSchema = z.object({
  profileId: z.string().nullable(),
  status: z.enum(["idle", "downloading", "extracting", "ready", "starting", "running", "stopping", "stopped", "error"]),
  pid: z.number().int().positive().nullable(),
}).passthrough();

export const workerResponseSchema = z.object({
  v: z.literal(1),
  id: z.string().nullable(),
  result: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }).optional(),
});

export const serverListResultSchema = z.object({
  servers: z.array(z.object({
    address: z.string(), name: z.string().nullable(),
    playerCount: z.number().int().nonnegative(), softMaxPlayerCount: z.number().int().nonnegative(),
    tags: z.array(z.string()), status: z.string(), hubAddress: z.string(),
    pingMs: z.number().nonnegative().nullable().optional(),
  }).passthrough()),
  failedHubs: z.array(z.string()),
  partialError: z.boolean(),
  revision: z.number().int().nonnegative().optional(),
  refreshing: z.boolean().optional(),
  stale: z.boolean().optional(),
});

export const shellUpdateStateSchema: z.ZodType<ShellUpdateState> = z.object({
  status: z.enum(["idle", "checking", "available", "downloading", "downloaded", "error", "disabled"]),
  currentVersion: z.string(), revision: z.number().int().nonnegative(),
  version: z.string().optional(), percent: z.number().min(0).max(100).optional(),
  message: z.string().optional(), checkedAt: z.string().datetime().optional(),
  releaseNotes: z.string().max(64000).optional(), releaseDate: z.string().datetime().optional(),
  transferred: z.number().finite().nonnegative().optional(), total: z.number().finite().nonnegative().optional(), bytesPerSecond: z.number().finite().nonnegative().optional(),
}).strict();

export const cacheTransferStateSchema=z.object({stage:z.enum(['idle','copying','verifying','ready','cancelled','error']),completedBytes:z.number().nonnegative(),totalBytes:z.number().nonnegative(),destination:z.string().nullable(),message:z.string().nullable().optional()});
export const cacheInfoSchema=z.object({paths:z.object({localPath:z.string(),userPath:z.string()}),state:cacheTransferStateSchema,warnings:z.array(z.string())});
export const seatWatchStateSchema=z.object({status:z.enum(['idle','checking','watching','unknown','offline','available','expired']),accountId:z.string().nullable().optional(),address:z.string().nullable().optional(),name:z.string().nullable().optional(),players:z.number().int().nullable().optional(),limit:z.number().int().nullable().optional(),expiresAt:z.string().nullable().optional(),message:z.string().nullable().optional()});
export const workerEventSchema = z.object({
  v: z.literal(1),
  event: z.string(),
  data: z.unknown(),
}).superRefine((value, context) => {
  if(value.event==='cache.progress'&&!cacheTransferStateSchema.safeParse(value.data).success)context.addIssue({code:z.ZodIssueCode.custom,message:'Invalid cache progress',path:['data']});
  if(value.event==='seatWatch.updated'&&!seatWatchStateSchema.safeParse(value.data).success)context.addIssue({code:z.ZodIssueCode.custom,message:'Invalid slot watch state',path:['data']});
  if (value.event === "notification.created" && !launcherNotificationSchema.safeParse(value.data).success)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid notification", path: ["data"] });
  if (value.event === "shell.updateState" && !shellUpdateStateSchema.safeParse(value.data).success)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid shell update", path: ["data"] });
  if (value.event === "servers.updated" && !serverListResultSchema.safeParse(value.data).success)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid catalog update", path: ["data"] });
  if (value.event === "monitoring.failed" && !z.object({ accountId: z.string(), message: z.string(), favorites: z.array(z.unknown()).nullable().optional() }).safeParse(value.data).success)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid monitoring failure", path: ["data"] });
});

const playtimeSeconds = z.number().int().nonnegative();
export const playtimeSummarySchema: z.ZodType<PlaytimeSummary> = z.object({
  accountId: z.string().nullable(), period: z.enum(["all", "today", "sevenDays"]), trackedSince: z.string().nullable(),
  generatedAt: z.string().nullable().optional(),
  dailyActivity: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), totalSeconds: playtimeSeconds })).max(7).optional(),
  totalSeconds: playtimeSeconds, sessionCount: playtimeSeconds, uniqueServers: playtimeSeconds,
  activeSession: z.object({ address: z.string(), name: z.string().nullable(), startedAt: z.string(), elapsedSeconds: playtimeSeconds }).nullable(),
  servers: z.array(z.object({ address: z.string(), name: z.string().nullable(), totalSeconds: playtimeSeconds, sessionCount: playtimeSeconds, lastPlayedAt: z.string().nullable(), active: z.boolean() })),
});
export const launcherNotificationSchema: z.ZodType<LauncherNotification> = z.object({
  id: z.string().min(1), kind: z.enum(["favorite-online", "launcher-update", "game-update","server-slot"]), title: z.string(), message: z.string(), createdAt: z.string(), readAt: z.string().nullable(),
  accountId: z.string().nullable().optional(),
  address: z.string().refine(value => {
    try { const url = new URL(value); return ["ss14:", "ss14s:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash; }
    catch { return false; }
  }, "Invalid server target").nullable().optional(),
});

export const presenceSnapshotSchema = z.object({
  state: z.enum(["launcher", "connecting", "updating", "playing"]),
  enabled: z.boolean().default(true),
  showNickname: z.boolean().default(true),
  accountName: z.string().nullable().optional().transform((value) => value ?? null),
  serverName: z.string().nullable().optional().transform((value) => value ?? null),
  address: z.string().nullable().optional().transform((value) => value ?? null),
  playerCount: z.number().int().nullable().optional().transform((value) => value ?? null),
  softMaxPlayerCount: z.number().int().nullable().optional().transform((value) => value ?? null),
  pingMs: z.number().nullable().optional().transform((value) => value ?? null),
  map: z.string().nullable().optional().transform((value) => value ?? null),
  mode: z.string().nullable().optional().transform((value) => value ?? null),
  startedAt: z.string().nullable().optional().transform((value) => value ?? null),
});
