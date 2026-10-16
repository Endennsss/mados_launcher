// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LauncherApi, NewsItem, ShellUpdateState } from "../contracts/launcher";
import { NewsView } from "./NewsView";
import { releaseRelation } from "./news-journal";

const news: NewsItem[] = [
  {title:"Mados 0.42.0",link:"https://github.com/Endennsss/mados_launcher/releases/tag/v0.42.0",date:"2026-10-15T12:00:00Z",source:"GitHub · Mados Launcher",version:"v0.42.0",summary:"Коротко",body:"## Изменения\n\nПолное описание релиза.\n\n- **Новая лента**\n- Исправления\n\n<script>window.pwned=true</script>"},
  {title:"События станции",link:"https://spacestation14.com/post/update",date:"2026-10-14T12:00:00Z",source:"Space Station 14",body:"Полный текст новости"},
];
const update:ShellUpdateState={status:"available",currentVersion:"0.41.0",version:"0.42.0",revision:1};
let host:HTMLDivElement, root:Root;
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);localStorage.clear();host=document.createElement("div");document.body.append(host);root=createRoot(host);window.mados={invoke:vi.fn(async()=>news),openExternal:vi.fn(async()=>undefined)} as unknown as LauncherApi;});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
const render=(accountId="a",onOpenUpdate=vi.fn())=>act(async()=>root.render(<NewsView key={accountId} accountId={accountId} update={update} onOpenUpdate={onOpenUpdate}/>));
const click=async(selector:string)=>{const button=document.querySelector<HTMLButtonElement>(selector);expect(button,selector).not.toBeNull();await act(async()=>button!.click());};

it("opens the complete release safely and records reading only after opening, per account",async()=>{
  await render(); expect(host.querySelector('[data-news-read="true"]')).toBeNull();
  await click('.news-feature [data-action="read-news"]');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Полное описание релиза");
  expect(document.querySelector('[role="dialog"] script')).toBeNull();
  expect(host.querySelector('[data-news-read="true"]')).not.toBeNull();
  await act(async()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await render("b"); expect(host.querySelector('[data-news-read="true"]')).toBeNull();
  await render("a"); expect(host.querySelector('[data-news-read="true"]')).not.toBeNull();
});
it("retains the loaded feed on refresh failure and offers retry",async()=>{
  await render();window.mados.invoke=vi.fn(async()=>{throw Error("Сеть недоступна");});
  await click('[aria-label="Обновить новости"]');
  expect(host.textContent).toContain("События станции");expect(host.querySelector('[role="alert"]')?.textContent).toContain("Сеть недоступна");
  window.mados.invoke=vi.fn(async()=>news) as LauncherApi["invoke"];
  await click('[data-action="retry-news"]');expect(host.querySelector('[role="alert"]')).toBeNull();
});
it("opens the actual available update without starting a download",async()=>{
  const open=vi.fn();await render("a",open);await click('.news-feature [data-action="open-update"]');expect(open).toHaveBeenCalledTimes(1);
});
it("returns keyboard focus to the unread filter after the opened item leaves that list",async()=>{
  await render();await click('.news-filters button:last-child');
  await click('.news-feature [data-action="read-news"]');
  expect(host.querySelector('.news-feature')).toBeNull();
  await click('[aria-label="Закрыть публикацию"]');
  expect(document.activeElement).toBe(host.querySelector('.news-filters [aria-pressed="true"]'));
});
it("never labels an older release or another repository as an available update",()=>{
  expect(releaseRelation(news[0],update)).toBe("available");
  expect(releaseRelation({...news[0],version:"v0.40.0"},update)).toBeNull();
  expect(releaseRelation({...news[0],version:"v0.41.0"},update)).toBe("installed");
  expect(releaseRelation({...news[0],link:"https://github.com/someone/other/releases/tag/v0.42.0"},update)).toBeNull();
  expect(releaseRelation(news[0],{...update,status:"idle"})).toBeNull();
});
