// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { LauncherApi, LauncherNotification, PlaytimeSummary, WorkerEvent } from "../contracts/launcher";
import { ConfirmProvider } from "./ConfirmDialog";
import { PlaytimeView } from "./PlaytimeView";
import { NotificationCenter, useNotifications } from "./NotificationCenter";

let host: HTMLDivElement, root: Root, listeners: Set<(event: WorkerEvent) => void>;
const summary: PlaytimeSummary = { accountId: "a", period: "all", trackedSince: "2026-10-09T12:00:00Z", generatedAt: "2026-10-15T12:00:00Z", totalSeconds: 7200, sessionCount: 2, uniqueServers: 2, activeSession: null,
  dailyActivity: [{ date: "2026-10-14", totalSeconds: 3600 }, { date: "2026-10-15", totalSeconds: 3600 }],
  servers: [{ address: "ss14://alpha", name: "Alpha", totalSeconds: 5400, sessionCount: 1, active: false, lastPlayedAt: "2026-10-15T12:00:00Z" }, { address: "ss14://beta", name: "Beta", totalSeconds: 1800, sessionCount: 1, active: false, lastPlayedAt: "2026-10-14T12:00:00Z" }] };
const note: LauncherNotification = { id: "n", accountId: "a", kind: "favorite-online", title: "Сервер снова доступен", message: "Alpha", address: "ss14://alpha", createdAt: new Date().toISOString(), readAt: null };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); listeners = new Set();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  window.mados = { invoke: vi.fn(async () => summary), onEvent: (fn: (event: WorkerEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); }, notifications: { list: vi.fn(async () => [note]), markRead: vi.fn(async () => ({marked:true})), clear: vi.fn(async () => ({removed:1})) } } as unknown as LauncherApi;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function click(selector: string) { const button = document.querySelector<HTMLButtonElement>(selector); expect(button, selector).not.toBeNull(); await act(async () => button!.click()); }
const renderPlaytime = (id = "a") => act(async () => root.render(<ConfirmProvider><PlaytimeView key={id} accountId={id} username="Ende" onBrowse={vi.fn()} /></ConfirmProvider>));

it("shows real daily values and proportional server time, including precise accessible durations", async () => {
  await renderPlaytime();
  expect(host.querySelector('[data-day="2026-10-15"]')?.getAttribute("aria-label")).toContain("1 ч");
  expect(host.querySelector('[data-server="ss14://alpha"] [role="meter"]')?.getAttribute("aria-valuenow")).toBe("75");
  expect(host.textContent).toContain("Alpha"); expect(host.textContent).toContain("2 ч");
});
it("ignores a slow earlier period response", async () => {
  let old!: (value: PlaytimeSummary) => void;
  window.mados.invoke = vi.fn((_method, params) => (params as {period:string}).period === "all" ? new Promise(resolve => { old = resolve; }) : Promise.resolve({...summary,period:"today",totalSeconds:600})) as LauncherApi["invoke"];
  await renderPlaytime(); await click('[data-period="today"]');
  await act(async () => old({...summary,totalSeconds:99999}));
  expect(host.querySelector('.playtime-total')?.textContent).toContain("10 мин");
});
it("clears previous account data immediately and rejects a mismatched worker summary", async () => {
  await renderPlaytime(); await renderPlaytime("b");
  expect(host.textContent).not.toContain("Alpha");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});
it("shows an actionable error rather than an empty chart on failed load", async () => {
  window.mados.invoke = vi.fn(async () => { throw Error("Нет связи"); }); await renderPlaytime();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Нет связи");
  window.mados.invoke = vi.fn(async () => summary) as LauncherApi["invoke"];
  await click('[data-action="retry-playtime"]'); expect(host.textContent).toContain("Alpha");
});
it("uses the worker elapsed time as the live baseline instead of the renderer wall clock", async () => {
  window.mados.invoke = vi.fn(async () => ({...summary,activeSession:{address:"ss14://alpha",name:"Alpha",startedAt:"2000-01-01T00:00:00Z",elapsedSeconds:120}})) as LauncherApi["invoke"];
  await renderPlaytime(); expect(host.querySelector('.playtime-live-value')?.textContent).toBe("2 мин");
});

it("keeps the selected period when clearing finishes after a period change", async () => {
  let finish!: (value: {removed:number}) => void;
  window.mados.invoke = vi.fn((method,params) => method === 'playtime.clear' ? new Promise(resolve=>{finish=resolve;}) : Promise.resolve({...summary,period:(params as {period:string}).period,totalSeconds:(params as {period:string}).period==='today'?600:7200})) as LauncherApi['invoke'];
  await renderPlaytime(); await click('[aria-label="Удалить историю"]'); await click('.mados-dialog .primary-button');
  await click('[data-period="today"]'); await act(async()=>finish({removed:1}));
  expect(host.querySelector('.playtime-total')?.textContent).toBe('10 мин');
});

it("stops showing a live session after exit even if the next summary request fails", async () => {
  window.mados.invoke = vi.fn(async () => ({...summary,activeSession:{address:"ss14://alpha",name:"Alpha",startedAt:"2026-10-15T11:58:00Z",elapsedSeconds:120}})) as LauncherApi["invoke"];
  await renderPlaytime();
  window.mados.invoke = vi.fn(async () => { throw Error("Worker недоступен"); });
  await act(async()=>{for(const fn of listeners)fn({v:1,event:"playtime.updated",data:{accountId:"a",address:"ss14://alpha",active:false}});});
  expect(host.querySelector('.playtime-live-value')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Worker недоступен');
});

let feed: ReturnType<typeof useNotifications>;
function Journal({accountId="a", action=vi.fn()}:{accountId?:string;action?:(item:LauncherNotification)=>void}) {
  feed = useNotifications(accountId);
  return <ConfirmProvider><NotificationCenter {...feed} accountId={accountId} onClose={vi.fn()} onAction={action} /></ConfirmProvider>;
}
it("groups today and earlier events, filters unread and opens the stored server target", async () => {
  const older = {...note,id:"old",readAt:note.createdAt,createdAt:"2020-01-01T12:00:00Z",message:"Older"};
  window.mados.notifications.list = vi.fn(async () => [note,older]); const action = vi.fn();
  await act(async () => root.render(<Journal action={action} />));
  expect(host.textContent).toContain("Сегодня"); expect(host.textContent).toContain("Ранее");
  await click('[data-filter="unread"]'); expect(host.textContent).not.toContain("Older");
  await click('[data-notification="n"] [data-action="open-notification"]'); expect(action).toHaveBeenCalledWith(note);
});
it("does not pretend a failed read succeeded and can retry", async () => {
  window.mados.notifications.markRead = vi.fn(async () => { throw Error("Не удалось сохранить"); });
  await act(async () => root.render(<Journal />)); await click('[data-notification="n"] [data-action="read-notification"]');
  expect(feed.items[0].readAt).toBeNull(); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Не удалось сохранить");
  window.mados.notifications.markRead = vi.fn(async () => ({marked:true}));
  await click('[data-notification="n"] [data-action="read-notification"]'); expect(feed.items[0].readAt).not.toBeNull();
});
it("isolates notification events and delayed reads when the account changes", async () => {
  let done!: (value: {marked:boolean}) => void;
  window.mados.notifications.markRead = vi.fn(() => new Promise<{marked:boolean}>(resolve=>{done=resolve;}));
  await act(async () => root.render(<Journal />)); await click('[data-notification="n"] [data-action="read-notification"]');
  window.mados.notifications.list = vi.fn(async () => []);
  await act(async () => root.render(<Journal accountId="b" />));
  await act(async () => { done({marked:true}); for(const fn of listeners) fn({v:1,event:"notification.created",data:note}); });
  expect(feed.items).toEqual([]); expect(feed.toast).toBeNull();
});
