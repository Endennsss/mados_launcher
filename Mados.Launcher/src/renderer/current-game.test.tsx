// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { LauncherApi, WorkerEvent } from "../contracts/launcher";
import type { LaunchActivity } from "./launch-status";
import { useCurrentGame } from "./current-game";
import { LaunchDock } from "./LaunchDock";

const playing:LaunchActivity={status:"ClientRunning",address:"ss14://alpha",name:"Alpha",contentBundle:false,startedAt:Date.now()};
it("loads the real current server, keeps newer presence and ignores other sessions and stale replies",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const listeners=new Set<(event:WorkerEvent)=>void>();const requests:Array<{address:string;resolve:(value:unknown)=>void}>=[];let state!:ReturnType<typeof useCurrentGame>;
  window.mados={invoke:(_method:string,params:{address:string})=>new Promise(resolve=>requests.push({address:params.address,resolve})),onEvent:(listener:(event:WorkerEvent)=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);}} as unknown as LauncherApi;
  function Fixture({activity}:{activity:LaunchActivity}){state=useCurrentGame(activity);return <span>{state.details?.map}</span>;}
  const emit=async(address:string,map:string)=>act(async()=>{listeners.forEach(fn=>fn({v:1,event:"presence.updated",data:{state:"playing",enabled:true,address,map,startedAt:new Date(playing.startedAt!).toISOString(),playerCount:12,pingMs:35}}));});
  try{
    await act(async()=>root.render(<Fixture activity={playing}/>));expect(requests[0].address).toBe("ss14://alpha");
    await emit("ss14://other","Wrong");expect(state.details).toBeNull();await emit("ss14://alpha","Box");expect(state.details?.map).toBe("Box");
    await act(async()=>requests[0].resolve({map:"Old"}));expect(state.details?.map).toBe("Box");
    await act(async()=>root.render(<Fixture activity={{...playing,address:"ss14://beta",startedAt:playing.startedAt!+1}}/>));expect(state.details).toBeNull();await emit("ss14://alpha","Wrong");expect(state.details).toBeNull();
    await act(async()=>requests[1].resolve({map:"Delta",playerCount:0,status:"online"}));expect(state.details?.playerCount).toBe(0);
    await act(async()=>root.render(<Fixture activity={{...playing,contentBundle:true}}/>));expect(requests).toHaveLength(2);expect(state.details).toBeNull();
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

it("expands live game metrics with real refresh and preserves the existing launch controls",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const host=document.createElement("div");document.body.append(host);const root=createRoot(host);let fail=false;
  const invoke=vi.fn(async()=>{if(fail)throw Error("Сервер не ответил");return {name:"Alpha",map:"Box",mode:"Sandbox",playerCount:0,softMaxPlayerCount:80,pingMs:24,status:"online"};});const details=vi.fn();
  window.mados={invoke,onEvent:()=>()=>{}} as unknown as LauncherApi;
  try{
    await act(async()=>root.render(<LaunchDock activity={playing} onDismiss={()=>{}} onOpenServer={details}/>));expect(invoke).toHaveBeenCalledWith("servers.info",{address:"ss14://alpha"});
    await act(async()=>host.querySelector<HTMLButtonElement>('.dock-expand')!.click());expect(host.querySelector('.current-game-stats')?.textContent).toContain("Box");expect(host.querySelector('.current-game-stats')?.textContent).toContain("0 / 80");
    await act(async()=>host.querySelector<HTMLButtonElement>('[data-action="session-details"]')!.click());expect(details).toHaveBeenCalledOnce();
    fail=true;await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Обновить данные текущего сервера"]')!.click());expect(host.querySelector('[role="alert"]')?.textContent).toContain("Сервер не ответил");expect(host.querySelector('.current-game-stats')?.textContent).toContain("Box");
    await act(async()=>root.render(<LaunchDock activity={{...playing,status:"Connecting",startedAt:null}} onDismiss={()=>{}}/>));expect(host.querySelector('.current-game-stats')).toBeNull();expect(host.textContent).toContain("Отменить");
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
