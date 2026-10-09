import { z } from "zod";

export const workerRequestSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const rendererMethodSchema = z.enum([
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

export const workerEventSchema = z.object({
  v: z.literal(1),
  event: z.string(),
  data: z.unknown(),
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
