// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LauncherApi, WorkerEvent } from "../contracts/launcher";
import { HomeDashboard } from "./HomeDashboard";
import { SessionRecap } from "./HomePlaytime";
import { homeBlocks, homeStorageKey, type HomeBlock } from "./home-personalization";

let host: HTMLDivElement, root: Root, listeners: Set<(event: WorkerEvent) => void>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); listeners = new Set();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  window.mados = { onEvent: (fn: (event: WorkerEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); }, invoke: vi.fn() } as unknown as LauncherApi;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function click(selector: string) { await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click()); }
async function emit(data: unknown) { await act(async () => { for (const fn of listeners) fn({ v: 1, event: "playtime.updated", data }); }); }
const completed = { accountId: "a", address: "ss14://station.test", name: "Station", startedAt: "2026-10-15T12:00:00Z", elapsedSeconds: 3600, active: false };
const summary = (accountId: string, seconds: number) => ({ accountId, servers: [{ address: completed.address, totalSeconds: seconds }] });

it("pins actual favorites, handles all blocks hidden and reports a storage failure", async () => {
  const favorites = ["A", "B"].map(name => ({ name, address: `ss14://${name.toLowerCase()}.test`, raiseTime: "" }));
  await act(async () => root.render(<HomeDashboard accountId="a" favorites={favorites} renderBlocks={ordered => Object.fromEntries(Object.keys(homeBlocks).map(id => [id, <span>{id === "favorites" ? ordered.map(favorite => favorite.name).join(",") : id}</span>])) as Record<HomeBlock, React.ReactNode>} />));
  await click('[aria-label="Настроить главную"]'); await click('.home-pin-button:nth-child(2)');
  expect(host.querySelector('[data-home-block="favorites"]')?.textContent).toBe("B,A");
  expect(JSON.parse(localStorage.getItem(homeStorageKey("a"))!).pinned).toEqual(["ss14://b.test"]);
  // Each interaction is a separate browser event so React commits the preceding layout.
  for (const button of [...host.querySelectorAll<HTMLButtonElement>('[role="switch"][aria-checked="true"]')]) await act(async () => button.click());
  expect(host.querySelector('.home-empty-layout')).not.toBeNull();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Disk full"); });
  await click('.home-editor-footer button');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("не сохранились");
  expect(host.querySelectorAll('[data-home-block]')).toHaveLength(6);
});

it("recovers corrupted preferences with a visible explanation", async () => {
  localStorage.setItem(homeStorageKey("a"), "{broken");
  await act(async () => root.render(<HomeDashboard accountId="a" favorites={[]} renderBlocks={() => Object.fromEntries(Object.keys(homeBlocks).map(id => [id, id])) as Record<HomeBlock, React.ReactNode>} />));
  expect(host.querySelectorAll('[data-home-block]')).toHaveLength(6);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("стандартный вид");
});

it("ignores late totals for a dismissed session while a newer recap is loading", async () => {
  const pending: Array<(value: unknown) => void> = [];
  window.mados.invoke = vi.fn(() => new Promise(resolve => pending.push(resolve))) as LauncherApi["invoke"];
  await act(async () => root.render(<SessionRecap accountId="a" launchBusy={false} onOpenPlaytime={() => undefined} />));
  await emit(completed); await click('[aria-label="Закрыть итоги игры"]');
  await emit({ ...completed, startedAt: "2026-10-15T14:00:00Z", elapsedSeconds: 120 });
  await act(async () => pending[0](summary("a", 99000)));
  expect(host.textContent).toContain("2 мин"); expect(host.textContent).not.toContain("1 д 3 ч");
  await act(async () => pending[1](summary("a", 3720)));
  expect(host.textContent).toContain("1 ч 2 мин");
});

it("rejects totals for the wrong account and can retry without losing the completed duration", async () => {
  let replyAccount = "b";
  window.mados.invoke = vi.fn(async () => summary(replyAccount, 7200)) as LauncherApi["invoke"];
  await act(async () => root.render(<SessionRecap accountId="a" launchBusy={false} onOpenPlaytime={() => undefined} />));
  await emit(completed);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Аккаунт изменился");
  expect(host.textContent).toContain("1 ч 0 мин"); expect(host.textContent).not.toContain("2 ч 0 мин");
  replyAccount = "a"; await click('.home-feedback button'); expect(host.textContent).toContain("2 ч 0 мин");
  await emit({ accountId: "a", cleared: 2 }); expect(host.querySelector('.session-recap')).toBeNull();
});

it("keeps the recap when a delayed heartbeat arrives after completion", async () => {
  window.mados.invoke = vi.fn(async () => summary("a", 7200)) as LauncherApi["invoke"];
  await act(async () => root.render(<SessionRecap accountId="a" launchBusy={false} onOpenPlaytime={() => undefined} />));
  await emit(completed);
  await emit({ ...completed, active: true, elapsedSeconds: 3585 });
  expect(host.querySelector('.session-recap')?.textContent).toContain("1 ч 0 мин");
  await emit({ ...completed, active: true, startedAt: "2026-10-15T14:00:00Z", elapsedSeconds: 0 });
  expect(host.querySelector('.session-recap')).toBeNull();
});
