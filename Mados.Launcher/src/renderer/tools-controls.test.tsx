// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConfirmProvider } from "./ConfirmDialog";
import { ToolsView } from "./ToolsView";
import type { LauncherApi, WorkerEvent } from "../contracts/launcher";

it("offers one process action per state and preserves folder access in More", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host=document.createElement("div"); document.body.append(host); const root=createRoot(host);
  const listeners=new Set<(event:WorkerEvent)=>void>(), openFolder=vi.fn(), start=vi.fn(async()=>({profileId:"local",status:"starting"}));
  window.mados={onEvent:(fn:(event:WorkerEvent)=>void)=>{listeners.add(fn);return()=>listeners.delete(fn)},localServers:{
    list:async()=>[{id:"local",name:"Моя станция",port:1212,bindAddress:"127.0.0.1"}],
    getStatus:async()=>({profileId:"local",status:"stopped"}),getConfig:async()=>({name:"Моя станция",rawToml:"[net]",port:1212}),backups:async()=>[],start,openFolder,
  }} as unknown as LauncherApi;
  try {
    await act(async()=>root.render(<ConfirmProvider><ToolsView onError={()=>{}} /></ConfirmProvider>));
    const primary=()=>host.querySelector<HTMLButtonElement>(".local-server-primary")!;
    expect(primary(), "a single state-aware process action").not.toBeNull();
    expect(primary().textContent).toContain("Запустить");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async()=>primary().click());expect(start).toHaveBeenCalledWith("local");
    expect(primary().disabled).toBe(true);expect(primary().textContent).toContain("Запускается");
    await act(async()=>{for(const fn of listeners)fn({v:1,event:"localServer.status",data:{profileId:"local",status:"running",pid:42}})});
    expect(primary().disabled).toBe(false);expect(primary().textContent).toContain("Остановить");
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Действия сервера"]')!.click());
    await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b=>b.textContent?.includes("Открыть папку"))!.click());
    expect(openFolder).toHaveBeenCalledWith("local");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  } finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()}
});
