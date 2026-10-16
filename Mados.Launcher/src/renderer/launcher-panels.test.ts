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
let activeAccount: typeof account;
let connectError: string | null;
const account = { id: "account-a", username: "Player", status: "available", active: true };
const station = { address: "ss14://station.example", name: "Station", playerCount: 99, softMaxPlayerCount: 80, tags: [], status: "online", hubAddress: "", roundStartTime: null, runLevel: null };

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); localStorage.setItem("mados.guide.v1", "done");
  localStorage.setItem("mados.lastServer.account-a", JSON.stringify({ ...station, name: "Old attempted server" }));
  listeners = new Set(); calls = []; loggedIn = true; activeAccount = account; connectError = null;
  window.mados = {
    invoke: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "app.getState") return { ready: true, loggedIn, version: "test", activeAccount, accounts: [activeAccount], favorites: [], compatibility: { outOfDate:true, intelDegradation:true, earlyAccess:false, rosetta:false, authOverride:false } };
      if (method === "settings.get") return { compatMode:false, verboseLogging:false, overrideAssets:false, language:"ru", multiAccounts:true, accountManagementUrl:"https://example.com/account", registerUrl:"https://example.com/register", discordUrl:"https://example.com/discord", websiteUrl:"https://example.com", discordPresenceEnabled:true, discordPresenceShowNickname:true, favoriteAvailabilityNotifications:true };
      if (method === "recentConnections.list") return [{ address: station.address, name: "Station", lastConnectedAt: "2026-10-15T12:00:00Z", playerCount: 99, pingMs: 20 }];
      if (method === "servers.info") return { name: "Station", status: "online", playerCount: 12, softMaxPlayerCount: 80, pingMs: 42, map: "Box", mode: "Sandbox", description: "Welcome aboard.", links: [] };
      if (method === "servers.list") return { servers: [station], partialError: false, failedHubs: [], refreshing: false, revision: 1 };
      if (method === "playtime.getSummary") return { accountId: activeAccount.id, period: "all", trackedSince: null, totalSeconds: 7500, sessionCount: 2, uniqueServers: 1, activeSession: null, servers: [{ address: station.address, name: "Station", totalSeconds: 7500, sessionCount: 2, lastPlayedAt: "2026-10-15T12:00:00Z", active: false }] };
      if (method === "servers.connect" && connectError) throw new Error(connectError);
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

async function search(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector);expect(input).not.toBeNull();
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input!.dispatchEvent(new Event("input",{bubbles:true}));});
}

it("opens an exact setting from Ctrl+K and searches other settings locally",async()=>{
  await act(async()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true})));
  await search('[role="combobox"]',"анимации");
  await act(async()=>document.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
  expect(host.querySelector('.settings-nav-item.active')?.textContent).toContain("Внешний вид");
  expect(document.activeElement?.getAttribute("data-setting-id")).toBe("motion");
  await search('[aria-label="Поиск по настройкам"]',"лог");
  await click('[data-setting-result="logging"]');
  expect(host.querySelector('.settings-nav-item.active')?.textContent).toContain("Диагностика");
  expect(document.activeElement?.getAttribute("data-setting-id")).toBe("logging");
  expect(calls.some(call=>call.method==='settings.update')).toBe(false);
});

it("searches a real catalog snapshot and opens server details without launching",async()=>{
  await click('[aria-label="Командная палитра"]');
  await search('[role="combobox"]',"station.example");
  expect(document.querySelector('.search-preview')?.textContent).toContain("Station");
  await act(async()=>document.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
  expect(host.querySelector('.server-inspector')?.textContent).toContain("Welcome aboard.");
  expect(calls.some(call=>call.method==='servers.connect')).toBe(false);
  expect(calls.filter(call=>call.method==='servers.list')).toHaveLength(1);
});

it("shows save success only after worker confirmation and preserves the setting on failure",async()=>{
  await click('[aria-label="Командная палитра"]');await search('[role="combobox"]',"логирование");
  await act(async()=>document.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
  const original=window.mados.invoke;let reject!:(reason:Error)=>void;
  window.mados.invoke=((method,params)=>method==="settings.update"?new Promise((_resolve,no)=>{reject=no;}):original(method,params)) as LauncherApi["invoke"];
  await click('[aria-label="Подробное логирование"]');
  expect(host.querySelector('[aria-label="Подробное логирование"]')?.getAttribute('aria-checked')).toBe('false');
  expect(host.querySelector('.setting-saved')).toBeNull();
  await act(async()=>reject(new Error("Запись не удалась")));
  expect(host.querySelector('.setting-save-error')?.textContent).toContain("Запись не удалась");
  window.mados.invoke=(async(method,params)=>method==="settings.update"?{...await original("settings.get") as object,...params as object}:original(method,params)) as LauncherApi["invoke"];
  await click('[aria-label="Подробное логирование"]');
  expect(host.querySelector('[aria-label="Подробное логирование"]')?.getAttribute('aria-checked')).toBe('true');
  expect(host.querySelector('.setting-saved')?.textContent).toContain("Сохранено");
});

it("keeps a failed settings save visible when the user searches for another parameter",async()=>{
 await click('[aria-label="Командная палитра"]');await search('[role="combobox"]',"логирование");
 await act(async()=>document.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
 let reject!:(reason:Error)=>void;const original=window.mados.invoke;
 window.mados.invoke=((method,params)=>method==="settings.update"?new Promise((_resolve,no)=>{reject=no;}):original(method,params)) as LauncherApi["invoke"];
 await click('[aria-label="Подробное логирование"]');await search('[aria-label="Поиск по настройкам"]',"язык");
 await act(async()=>reject(new Error("Настройки не записаны")));
 expect(host.querySelector('[role="alert"]')?.textContent).toContain("Настройки не записаны");
 await click('[data-action="return-to-failed-setting"]');
 expect(host.querySelector('[data-setting-id="logging"]')).not.toBeNull();
 expect(host.querySelector('[aria-label="Подробное логирование"]')?.getAttribute("aria-checked")).toBe("false");
});

it("ignores the legacy official-launcher flag while retaining hardware warnings", () => {
  expect(host.textContent).not.toContain("Версия лаунчера устарела");
  expect(host.textContent).toContain("Intel");
});

it("lets the player customize their home without triggering the file drop overlay", async () => {
  await click('[aria-label="Настроить главную"]');
  expect(host.querySelector('.home-customizer')).not.toBeNull();
  await click('[aria-label="Показывать блок Недавние подключения"]');
  expect(host.querySelector('[data-home-block="recent"]')).toBeNull();
  const drag = new Event('dragover', {bubbles: true, cancelable: true});
  Object.defineProperty(drag, 'dataTransfer', {value: {types: ['application/x-mados-home-block']}});
  await act(async () => window.dispatchEvent(drag));
  expect(host.querySelector('.drop-overlay')).toBeNull();
});

it("shows the worker's completed session and reconnects to its server", async () => {
  await emit('playtime.updated', {accountId: account.id, address: station.address, name: 'Station', startedAt: '2026-10-15T12:00:00Z', elapsedSeconds: 3720, active: false});
  expect(host.querySelector('.session-recap')?.textContent).toContain('1 ч 2 мин');
  expect(host.querySelector('.session-recap')?.textContent).toContain('2 ч 5 мин');
  await click('.session-recap .primary-button');
  expect(calls).toContainEqual({method: 'servers.connect', params: {address: station.address, name: 'Station'}});
});

it("persists block ordering and visibility separately for each account, with a reset", async () => {
  await click('[aria-label="Настроить главную"]');
  await click('[aria-label="Выше: Избранные серверы"]');
  await click('[aria-label="Показывать блок Недавние подключения"]');
  expect(host.querySelector('[data-home-block]')?.getAttribute('data-home-block')).toBe('favorites');
  activeAccount = { ...account, id: "account-b" }; await emit('auth.changed', { activeAccount, accounts: [activeAccount], favorites: [] });
  expect(host.querySelector('[data-home-block]')?.getAttribute('data-home-block')).toBe('lastServer');
  expect(host.querySelector('[data-home-block="recent"]')).not.toBeNull();
  activeAccount = account; await emit('auth.changed', { activeAccount, accounts: [activeAccount], favorites: [] });
  expect(host.querySelector('[data-home-block]')?.getAttribute('data-home-block')).toBe('favorites');
  expect(host.querySelector('[data-home-block="recent"]')).toBeNull();
  await click('[aria-label="Настроить главную"]');
  await click('.home-editor-footer button');
  expect(host.querySelector('[data-home-block]')?.getAttribute('data-home-block')).toBe('lastServer');
  expect(host.querySelector('[data-home-block="recent"]')).not.toBeNull();
});

const endedSession = { accountId: account.id, address: station.address, name: 'Station', startedAt: '2026-10-15T12:00:00Z', elapsedSeconds: 3720, active: false };
it("ignores active sessions and other accounts, and does not resurrect a dismissed recap", async () => {
  await emit('playtime.updated', { ...endedSession, active: true });
  await emit('playtime.updated', { ...endedSession, accountId: 'account-b' });
  await emit('connection.progress', { status: 'ClientExited' });
  expect(host.querySelector('.session-recap')).toBeNull();
  await emit('playtime.updated', endedSession);
  await click('[aria-label="Закрыть итоги игры"]');
  await emit('playtime.updated', endedSession);
  expect(host.querySelector('.session-recap')).toBeNull();
});

it("keeps the recap actionable after a failed reconnect and clears it on the next connection", async () => {
  await emit('playtime.updated', endedSession); connectError = 'Сервер недоступен';
  await click('.session-recap .primary-button');
  expect(host.querySelector('.session-recap [role="alert"]')?.textContent).toContain(connectError);
  expect(host.querySelector<HTMLButtonElement>('.session-recap .primary-button')?.disabled).toBe(false);
  await emit('connection.started', { address: station.address });
  expect(host.querySelector('.session-recap')).toBeNull();
});

it("shows the weekly summary from the existing worker API", () => {
  expect(calls).toContainEqual({ method: 'playtime.getSummary', params: { period: 'sevenDays' } });
  expect(host.querySelector('.home-week')?.textContent).toContain('2 ч 5 мин');
});

it("waits for the launch dock to close before showing a completed recap", async () => {
  await emit('connection.progress', { status: 'ClientRunning' });
  await emit('playtime.updated', endedSession);
  await emit('connection.failed', { status: 'ConnectionFailed', message: 'Соединение завершено' });
  expect(host.querySelector('.launch-dock')).not.toBeNull();
  expect(host.querySelector('.session-recap')).toBeNull();
  await click('[aria-label="Закрыть состояние запуска"]');
  expect(host.querySelector('.session-recap')?.textContent).toContain('1 ч 2 мин');
});

it("opens expired-account login with its username, keeps the current account, and restores focus on cancel", async () => {
  const expiredAccount = { ...account, id: 'expired', username: 'Old Pilot', active: false, status: 'expired' };
  await emit('auth.changed', { activeAccount: account, accounts: [account, expiredAccount], favorites: [] });
  await click('[aria-label="Аккаунты"]');
  await act(async () => document.querySelector<HTMLButtonElement>('[data-account-id="expired"]')!.click());
  expect(host.querySelector<HTMLInputElement>('input[autocomplete="username"]')?.value).toBe('Old Pilot');
  expect(host.querySelector('.login-copy')?.textContent).toContain('Войти снова');
  expect(document.activeElement).toBe(host.querySelector('input[type="password"]'));
  expect(calls.some(call => call.method === 'auth.switchAccount')).toBe(false);
  await click('.login-cancel');
  expect(host.querySelector('.account-copy')?.textContent).toContain('Player');
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Аккаунты"]'));
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
