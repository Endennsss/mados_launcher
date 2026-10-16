// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LauncherApi, LauncherState, Server, ServerListResult, WorkerEvent } from "../contracts/launcher";
import { App } from "./App";

const station: Server = {
  address: "ss14://station.example", name: "Test Station", playerCount: 12, softMaxPlayerCount: 80,
  roundStartTime: null, runLevel: null, tags: ["lang:ru"], status: "online", hubAddress: "https://hub.example/", pingMs: null,
};
const state: LauncherState = {
  ready: true, loggedIn: true, version: "test", favorites: [],
  activeAccount: { id: "account-a", username: "Player", status: "available", active: true },
  accounts: [{ id: "account-a", username: "Player", status: "available", active: true }],
};

describe("catalog screen with progressive worker responses", () => {
  let root: Root;
  let container: HTMLDivElement;
  let reply: (result: ServerListResult) => void;
  let rejectList: (error: Error) => void;
  let events: Set<(event: WorkerEvent) => void>;
  let commands: Array<{ method: string; params: unknown }>;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    localStorage.setItem("mados.guide.v1", "done");
    events = new Set();
    commands = [];
    const pendingList = new Promise<ServerListResult>((resolve,reject) => { reply = resolve; rejectList=reject; });
    const api = {
      invoke: async (method: string, params: unknown) => {
        commands.push({ method, params });
        if (method === "app.getState") return state;
        if (method === "settings.get") return null;
        if (method === "recentConnections.list") return [];
        if (method === "servers.list") return pendingList;
        if (method === "servers.connect") return { ok: true };
        if (method === "favorites.remove") return [];
        throw new Error(`Unexpected IPC method: ${method}`);
      },
      onEvent: (listener: (event: WorkerEvent) => void) => { events.add(listener); return () => events.delete(listener); },
      onDiscordStatus: () => () => undefined,
      launchProfiles: { list: async () => [] },
      notifications: { list: async () => [] },
      serverNotes: { list: async () => [] },
      monitoring: { getFavorites: async () => ({ accountId: "account-a", favorites: [] }) },
    };
    window.mados = api as unknown as LauncherApi;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(App)); });
    const serversTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".side-nav button")).find(button => button.textContent === "Серверы")!;
    await act(async () => { serversTab.click(); });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function update(data: ServerListResult) {
    await act(async () => { for (const listener of events) listener({ v: 1, event: "servers.updated", data }); });
  }

  it.each([
    ["ss14://station.example", "ss14://station.example:1212/"],
    ["ss14://station.example:1212/", "ss14://station.example"],
    ["ss14s://station.example", "ss14s://station.example:443/"],
    ["ss14://station.example", "ss14://STATION.example:1212/"],
  ])("keeps restored favorite %s selected for catalog address %s", async (savedAddress, catalogAddress) => {
    await act(async () => {
      for (const listener of events) listener({ v: 1, event: "auth.changed", data: {
        accounts: state.accounts, activeAccount: state.activeAccount,
        favorites: [{ address: savedAddress, name: station.name }],
      } });
    });
    await update({ servers: [{ ...station, address: catalogAddress }], failedHubs: [], partialError: false, revision: 1, refreshing: false });
    const star = container.querySelector<HTMLButtonElement>(".server-card .star-button")!;
    expect(star.getAttribute("aria-label")).toBe("Удалить из избранного");
    await act(async () => star.click());
    expect(commands).toContainEqual({ method: "favorites.remove", params: { address: savedAddress } });
    expect(commands.some(command => command.method === "favorites.add")).toBe(false);
    expect(star.getAttribute("aria-label")).toBe("Добавить в избранное");
  });

  it("offers network retry instead of a misleading no-results state after initial failure",async()=>{
    await act(async()=>rejectList(Error("Нет соединения")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Нет соединения");
    expect(container.querySelector('[data-action="retry-catalog"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Ничего не найдено");
  });

  it("renders connectable cards before pings and ignores a late empty RPC response", async () => {
    expect(container.querySelector(".server-skeleton")).not.toBeNull();
    await update({ servers: [station], failedHubs: [], partialError: false, revision: 2, refreshing: true });
    expect(container.querySelector(".server-skeleton")).toBeNull();
    const play = container.querySelector<HTMLButtonElement>(".server-card .full-button")!;
    expect(play.disabled).toBe(false);
    await act(async () => { play.click(); });
    expect(commands).toContainEqual({ method: "servers.connect", params: { address: "ss14://station.example", name: "Test Station" } });
    await update({ servers: [{ ...station, pingMs: 42 }], failedHubs: [], partialError: false, revision: 3, refreshing: false });
    await act(async () => { reply({ servers: [], failedHubs: [], partialError: false, revision: 1, refreshing: true }); });
    expect(container.querySelector(".server-card")?.textContent).toContain("42 ms");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Обновить"]')?.disabled).toBe(false);
    expect(container.querySelector(".server-skeleton")).toBeNull();
  });

  it("ends loading with a network error when every hub fails", async () => {
    await act(async () => { reply({ servers: [], failedHubs: [], partialError: false, revision: 1, refreshing: true }); });
    await update({ servers: [], failedHubs: ["https://hub.example/"], partialError: false, revision: 2, refreshing: false });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось загрузить");
    expect(container.querySelector(".server-skeleton")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Обновить"]')?.disabled).toBe(false);
  });

  it("keeps catalog utilities collapsed initially and opens only the requested panel", async () => {
    await update({ servers: [station], failedHubs: [], partialError: false, revision: 1, refreshing: false });
    expect(container.querySelector(".server-card")).not.toBeNull();
    const monitoring = container.querySelector<HTMLElement>("#catalog-monitoring")!;
    const profiles = container.querySelector<HTMLElement>("#catalog-profiles")!;
    expect(monitoring, "monitoring belongs in a collapsible panel").not.toBeNull();
    expect(monitoring.hidden).toBe(true);
    expect(profiles.hidden).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-controls="catalog-monitoring"]')!.click());
    expect(monitoring.hidden).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-controls="catalog-profiles"]')!.click());
    expect(monitoring.hidden).toBe(true);
    expect(profiles.hidden).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-controls="catalog-profiles"]')!.click());
    expect(profiles.hidden).toBe(true);
  });

  it("opens monitoring from the command palette without a manual catalog refresh", async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Командная палитра"]')!.click());
    const command = [...document.querySelectorAll<HTMLButtonElement>(".command-palette-item")].find(button => button.textContent?.includes("мониторинг"));
    expect(command).not.toBeUndefined();
    await act(async () => command!.click());
    expect(container.querySelector<HTMLElement>("#catalog-monitoring")!.hidden).toBe(false);
    expect(commands.some(command => command.method === "servers.refresh")).toBe(false);
  });

  it("shows deferred monitoring failures only for the active account and clears them on success", async () => {
    const fail = async (accountId: string) => act(async () => {
      for (const listener of events) listener({ v: 1, event: "monitoring.failed", data: { accountId, message: "Не все избранные серверы ответили" } });
    });
    await fail("account-b");
    expect(container.textContent).not.toContain("Не все избранные серверы ответили");
    await fail("account-a");
    expect(container.textContent).toContain("Не все избранные серверы ответили");
    await act(async () => {
      for (const listener of events) listener({ v: 1, event: "monitoring.updated", data: { accountId: "account-a", favorites: [] } });
    });
    expect(container.textContent).not.toContain("Не все избранные серверы ответили");
  });
});
