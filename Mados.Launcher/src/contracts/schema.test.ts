import { describe, expect, it } from "vitest";
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
