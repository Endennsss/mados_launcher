import { describe, expect, it } from "vitest";
import { playtimeSummarySchema, launcherNotificationSchema } from "./schema";
import { validateRendererParams } from "./schema";
it('restricts personal toolkit commands and validates their progress events',()=>{
 for(const method of ['cache.info','cache.move','replays.list','replays.play','personal.restore','seatWatch.start','app.restart'])expect(rendererInvokeSchema.safeParse({method,params:{}}).success).toBe(true);
 expect(rendererInvokeSchema.safeParse({method:'personal.apply',params:{}}).success).toBe(false);
 expect(()=>validateRendererParams('replays.play',{id:'replay',path:'C:/secret.zip'})).toThrow();
 expect(()=>validateRendererParams('seatWatch.start',{address:'ss14://station',accountId:'someone-else'})).toThrow();
 expect(workerEventSchema.safeParse({v:1,event:'cache.progress',data:{stage:'ready',completedBytes:-1,totalBytes:4,destination:'D:/cache'}}).success).toBe(false);
 expect(workerEventSchema.safeParse({v:1,event:'seatWatch.updated',data:{status:'available',accountId:'a',players:10,limit:40}}).success).toBe(true);
});

it("allows maintenance requests without accepting arbitrary cleanup paths or account overrides",()=>{
  for(const method of ["diagnostics.run","storage.scan","storage.preview","storage.clean"])expect(rendererInvokeSchema.safeParse({method,params:{}}).success).toBe(true);
  expect(()=>validateRendererParams("storage.clean",{planId:"a".repeat(32),path:"C:/Users"})).toThrow();
  expect(()=>validateRendererParams("storage.preview",{ids:["../../settings.db"]})).toThrow();
  expect(()=>validateRendererParams("diagnostics.run",{address:"ss14://station",accountId:"other"})).toThrow();
  expect(validateRendererParams("storage.preview",{ids:["content:123"]})).toEqual({ids:["content:123"]});
});

it("rejects negative daily playtime and unsafe notification targets", () => {
  const summary={accountId:"a",period:"all",trackedSince:null,totalSeconds:0,sessionCount:0,uniqueServers:0,activeSession:null,servers:[],dailyActivity:[{date:"2026-10-15",totalSeconds:60}]};
  expect(playtimeSummarySchema.safeParse(summary).success).toBe(true);
  expect(playtimeSummarySchema.safeParse({...summary,dailyActivity:[{date:"2026-10-15",totalSeconds:-1}]}).success).toBe(false);
  const notification={id:"n",kind:"favorite-online",title:"Online",message:"Server",createdAt:new Date().toISOString(),readAt:null,accountId:"a",address:"ss14://station.example"};
  expect(launcherNotificationSchema.safeParse(notification).success).toBe(true);
  expect(launcherNotificationSchema.safeParse({...notification,address:"ss14://station.example?token=secret"}).success).toBe(false);
  expect(launcherNotificationSchema.safeParse({...notification,address:"https://example.com"}).success).toBe(false);
});
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { presenceSnapshotSchema, publicCdnUrlSchema, rendererInvokeSchema, toolsMethodParams, workerEventSchema, workerResponseSchema } from "./schema";

const ipcContract = JSON.parse(readFileSync(join(process.cwd(), "src", "contracts", "ipc.schema.json"), "utf8")) as {
  "x-methods": Record<string, string[]>;
};

describe("Mados worker contract", () => {
  it("accepts a versioned successful response", () => {
    expect(workerResponseSchema.parse({ v: 1, id: "request-1", result: { ready: true } })).toMatchObject({ id: "request-1" });
  });

  it("accepts events without exposing an unversioned shape", () => {
    expect(workerEventSchema.parse({ v: 1, event: "app.ready", data: {} }).event).toBe("app.ready");
  });

  it("validates shell update states and progress bounds", () => {
    const event = {v:1,event:"shell.updateState",data:{status:"downloading",currentVersion:"0.40.3",version:"0.41.0",revision:2,percent:50}};
    expect(workerEventSchema.safeParse(event).success).toBe(true);
    expect(workerEventSchema.safeParse({...event,data:{...event.data,percent:120}}).success).toBe(false);
    expect(workerEventSchema.safeParse({...event,data:{...event.data,revision:-1}}).success).toBe(false);
  });

  it("accepts progressive catalogs and rejects malformed refresh metadata", () => {
    const data = { servers: [], failedHubs: [], partialError: false, revision: 4, refreshing: true, stale: false };
    expect(workerEventSchema.safeParse({ v: 1, event: "servers.updated", data }).success).toBe(true);
    expect(workerEventSchema.safeParse({ v: 1, event: "servers.updated", data: { ...data, revision: -1 } }).success).toBe(false);
    expect(workerEventSchema.safeParse({ v: 1, event: "servers.updated", data: { ...data, refreshing: "yes" } }).success).toBe(false);
  });

  it("requires account-scoped monitoring failures with a safe display message", () => {
    const event = { v: 1, event: "monitoring.failed", data: { accountId: "account-a", message: "Refresh failed", favorites: [] } };
    expect(workerEventSchema.safeParse(event).success).toBe(true);
    expect(workerEventSchema.safeParse({ ...event, data: { message: "Refresh failed" } }).success).toBe(false);
  });

  it("validates the structured presence event", () => {
    expect(presenceSnapshotSchema.parse({
      state: "playing",
      enabled: true,
      showNickname: true,
      accountName: "Ende",
      serverName: "Mados Station",
      address: "ss14://station.example:1212?token=hidden",
      playerCount: 12,
      softMaxPlayerCount: 80,
      pingMs: 34,
      map: "Box",
      mode: "Roleplay",
      startedAt: "2026-10-02T12:00:00Z",
    }).state).toBe("playing");
  });

  it("keeps renderer IPC methods on the explicit allowlist", () => {
    expect(rendererInvokeSchema.safeParse({ method: "servers.list", params: {} }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "playtime.getSummary", params: { period: "all" } }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "playtime.clear", params: {} }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "recentConnections.list", params: { limit: 5 } }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "serverNotes.list", params: {} }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "serverNotes.upsert", params: { address: "ss14://station.example", text: "note" } }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "serverNotes.remove", params: { address: "ss14://station.example" } }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "monitoring.getFavorites", params: {} }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "monitoring.refresh", params: {} }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "launchProfiles.create", params: { name: "Main", address: "ss14://station.example" } }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "notifications.list", params: {} }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "tools.cdn.inspect", params: { sourceUrl: "https://cdn.ss14.org/fork/fish_station" } }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "tools.cdn.import", params: { sourceUrl: "https://cdn.ss14.org/fork/fish_station" } }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "localServers.start", params: { id: "profile-1" } }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "localServers.saveConfig", params: { id: "profile-1", config: {} } }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "fs.readFile", params: {} }).success).toBe(false);
  });

  it("checks the TypeScript allowlist against the versioned JSON contract", () => {
    const documented = new Set(Object.entries(ipcContract["x-methods"]).flatMap(([group, methods]) => methods.map((method) => `${group}.${method}`)));
    expect(rendererInvokeSchema.shape.method.options.every((method) => documented.has(method))).toBe(true);
  });

  it("rejects unsafe CDN sources and local-server network binds", () => {
    expect(publicCdnUrlSchema.safeParse("http://cdn.ss14.org/fork/test").success).toBe(false);
    expect(publicCdnUrlSchema.safeParse("https://user:secret@cdn.ss14.org/fork/test").success).toBe(false);
    expect(publicCdnUrlSchema.safeParse("https://localhost/fork/test").success).toBe(false);
    expect(publicCdnUrlSchema.safeParse("https://cdn.ss14.org/fork/test?token=secret").success).toBe(false);
    expect(toolsMethodParams["localServers.update"].safeParse({ id: "profile-1", bindAddress: "0.0.0.0" }).success).toBe(false);
    expect(toolsMethodParams["localServers.update"].safeParse({ id: "profile-1", bindAddress: "127.0.0.1" }).success).toBe(true);
  });

  it("requires an operation id and explicit config edit mode", () => {
    expect(toolsMethodParams["tools.cdn.import"].safeParse({ sourceUrl: "https://cdn.ss14.org/fork/test" }).success).toBe(false);
    expect(toolsMethodParams["tools.cdn.import"].safeParse({ operationId: "00000000-0000-4000-8000-000000000001", sourceUrl: "https://cdn.ss14.org/fork/test" }).success).toBe(true);
    expect(toolsMethodParams["localServers.saveConfig"].safeParse({ id: "profile-1", config: {}, mode: "raw" }).success).toBe(false);
  });
});
