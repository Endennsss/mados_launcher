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
