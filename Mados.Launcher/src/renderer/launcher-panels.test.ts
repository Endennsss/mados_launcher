// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LauncherApi, WorkerEvent } from "../contracts/launcher";
import { App } from "./App";

let root: Root, host: HTMLDivElement;
let listeners: Set<(event: WorkerEvent) => void>;
let calls: Array<{ method: string; params: unknown }>;
let loggedIn: boolean;
const account = { id: "account-a", username: "Player", status: "available", active: true };
const station = { address: "ss14://station.example", name: "Station", playerCount: 99, softMaxPlayerCount: 80, tags: [], status: "online", hubAddress: "", roundStartTime: null, runLevel: null };

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  localStorage.setItem("mados.lastServer.account-a", JSON.stringify({ ...station, name: "Old attempted server" }));
  listeners = new Set(); calls = []; loggedIn = true;
  window.mados = {
    invoke: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "app.getState") return { ready: true, loggedIn, version: "test", activeAccount: account, accounts: [account], favorites: [], compatibility: { outOfDate:true, intelDegradation:true, earlyAccess:false, rosetta:false, authOverride:false } };
      if (method === "settings.get") return null;
      if (method === "recentConnections.list") return [{ address: station.address, name: "Station", lastConnectedAt: "2026-10-15T12:00:00Z", playerCount: 99, pingMs: 20 }];
      if (method === "servers.info") return { name: "Station", status: "online", playerCount: 12, softMaxPlayerCount: 80, pingMs: 42, map: "Box", mode: "Sandbox", description: "Welcome aboard.", links: [] };
      if (method === "servers.list") return { servers: [station], partialError: false, failedHubs: [], refreshing: false, revision: 1 };
      if (method === "playtime.getSummary") return { accountId: account.id, period: "all", trackedSince: null, totalSeconds: 7500, sessionCount: 2, uniqueServers: 1, activeSession: null, servers: [{ address: station.address, name: "Station", totalSeconds: 7500, sessionCount: 2, lastPlayedAt: "2026-10-15T12:00:00Z", active: false }] };
      if (["servers.connect", "connection.cancel", "connection.confirmPrivacyPolicy"].includes(method)) return { ok: true };
      throw new Error(`Unexpected IPC: ${method}`);
    },
    onEvent: (fn: (event: WorkerEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    onDiscordStatus: () => () => undefined,
    notifications: { list: async () => [] }, launchProfiles: { list: async () => [] },
    serverNotes: { list: async () => [] }, monitoring: { getFavorites: async () => ({ accountId: account.id, favorites: [] }) },
  } as unknown as LauncherApi;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(App)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function emit(event: string, data: unknown) { await act(async () => { for (const listener of listeners) listener({ v: 1, event, data }); }); }
async function click(selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => button!.click());
}

it("ignores the legacy official-launcher flag while retaining hardware warnings", () => {
  expect(host.textContent).not.toContain("Версия лаунчера устарела");
  expect(host.textContent).toContain("Intel");
});

it("keeps newer updater events when an older snapshot arrives",async()=>{
  await emit("shell.updateState",{status:"downloaded",currentVersion:"0.40.3",version:"0.41.0",revision:3});
  await emit("shell.updateState",{status:"available",currentVersion:"0.40.3",version:"0.40.9",revision:2});
  expect(host.querySelector('.shell-update-banner')?.textContent).toContain("0.41.0 готов");
  expect(host.querySelector('.shell-update-banner')?.textContent).not.toContain("0.40.9");
});

it("shows release notifications before account login",async()=>{
  loggedIn=false;
  await emit("auth.changed",{});
  await emit("shell.updateState",{status:"available",currentVersion:"0.40.3",version:"0.41.0",revision:1});
  expect(host.querySelector('.login-screen')).not.toBeNull();
  expect(host.querySelector('.login-update-notice')?.textContent).toContain("Скачать");
});

it("uses successful history and fresh online counts in the return card, then connects to that server", async () => {
  const card = host.querySelector(".last-server-card");
  expect(card?.textContent).toContain("Station");
  expect(card?.textContent).not.toContain("Old attempted server");
  expect(card?.textContent).toContain("12 / 80");
  expect(card?.textContent).toContain("2 ч 5 мин");
  await click(".last-server-card .primary-button");
  expect(calls).toContainEqual({ method: "servers.connect", params: { address: station.address, name: "Station" } });
});

it("opens server information alongside the catalog without losing scroll and restores focus on Escape", async () => {
  await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>(".side-nav button")).find(b => b.textContent === "Серверы")!.click());
  const scroll = host.querySelector<HTMLElement>(".content-scroll")!; scroll.scrollTop = 230;
  const card = host.querySelector<HTMLElement>(".server-card")!; card.focus();
  await act(async () => card.click());
  const panel = host.querySelector(".server-inspector");
  expect(panel?.getAttribute("aria-modal")).not.toBe("true");
  expect(panel?.textContent).toContain("Welcome aboard.");
  expect(panel?.textContent).toContain("Box");
  expect(panel?.textContent).toContain("Sandbox");
  expect(scroll.scrollTop).toBe(230);
  expect(document.body.style.overflow).not.toBe("hidden");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(host.querySelector(".server-inspector")).toBeNull();
  expect(document.activeElement).toBe(card);
});

it("keeps the bottom launch panel through download and running, then removes it on exit", async () => {
  await emit("connection.started", { address: station.address, name: "Station" });
  await emit("update.progress", { status: "DownloadingClientUpdate", progress: { downloaded: 25, total: 100 } });
  expect(host.querySelector(".launch-dock")?.textContent).toContain("Station");
  expect(host.querySelector(".launch-dock")?.textContent).toContain("25%");
  expect(host.querySelector(".global-status-stack .launch-dock")).toBeNull();
  await emit("update.completed", { status: "Ready" });
  expect(host.querySelector(".launch-dock")).not.toBeNull();
  await emit("connection.progress", { status: "ClientRunning" });
  await emit("connection.completed", { status: "ClientRunning" });
  expect(host.querySelector(".launch-dock")?.textContent).toContain("Сейчас играете");
  expect(host.querySelector(".launch-dock")?.textContent).not.toContain("Отменить");
  expect(host.querySelector(".last-server-card .spin")).toBeNull();
  await emit("connection.progress", { status: "ClientExited" });
  expect(host.querySelector(".launch-dock")).toBeNull();
});

it("replaces an open home inspector when another card is selected", async () => {
  await click(".last-server-details");
  await click(".recent-connection-card");
  expect(host.querySelectorAll(".server-inspector")).toHaveLength(1);
});

it("keeps the privacy decision actionable and sends acceptance to the worker", async () => {
  await emit("connection.progress", { status: "AwaitingPrivacyPolicyAcceptance", privacyPolicy: { link: "https://station.example/privacy", identifier: "policy", version: "1" } });
  expect(host.querySelector(".launch-dock")?.textContent).toContain("политикой сервера");
  await click('.launch-dock button[data-action="accept-policy"]');
  expect(calls).toContainEqual({ method: "connection.confirmPrivacyPolicy", params: { accepted: true } });
});

it("changes launch icon only with its phase, preserving animation during progress updates", async () => {
  await emit("connection.started", { address: station.address, name: "Station" });
  await emit("update.progress", { status: "DownloadingClientUpdate", progress: { downloaded: 25, total: 100 } });
  const downloadIcon = host.querySelector('.launch-dock-icon[data-phase="download"]');
  expect(downloadIcon).not.toBeNull();
  await emit("update.progress", { status: "DownloadingClientUpdate", progress: { downloaded: 26, total: 100 } });
  expect(host.querySelector(".launch-dock-icon")).toBe(downloadIcon);
  await emit("update.progress", { status: "Verifying" });
  expect(host.querySelector('.launch-dock-icon[data-phase="verify"]')).not.toBeNull();
  await emit("connection.progress", { status: "ClientRunning" });
  expect(host.querySelector('.launch-dock-icon[data-phase="playing"]')).not.toBeNull();
  expect(host.querySelector('.launch-dock-icon .spin')).toBeNull();
  const playingIcon = host.querySelector(".launch-dock-icon");
  await emit("connection.completed", { status: "ClientRunning" });
  expect(host.querySelector(".launch-dock-icon")).toBe(playingIcon);
});
