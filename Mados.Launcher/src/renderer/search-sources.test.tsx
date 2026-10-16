// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LauncherApi, LauncherState, LaunchProfile, Server, ServerListResult, WorkerEvent } from "../contracts/launcher";
import { LauncherSearch } from "./LauncherSearch";

let root:Root,host:HTMLDivElement,listeners:Set<(event:WorkerEvent)=>void>;
const station:Server={address:"ss14://station",name:"Station",playerCount:5,softMaxPlayerCount:80,status:"online",roundStartTime:null,runLevel:null,tags:[],hubAddress:""};
const state=(id:string):LauncherState=>({ready:true,loggedIn:true,version:"test",accounts:[],activeAccount:{id,username:id,active:true,status:"available"},favorites:[{name:`Favorite ${id}`,address:`ss14://${id}.example`,raiseTime:"2026-01-01"}]});
const catalog=(name:string,revision:number):ServerListResult=>({servers:[{...station,name}],revision,partialError:false,failedHubs:[],refreshing:false});
const profile=(id:string):LaunchProfile=>({id,name:`Profile ${id}`,address:`ss14://${id}.example`,createdAt:"2026-01-01",lastUsedAt:null});
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);host=document.createElement("div");document.body.append(host);root=createRoot(host);listeners=new Set();window.mados={invoke:vi.fn(async()=>catalog("Station",1)),launchProfiles:{list:vi.fn(async()=>[])},onEvent:(fn:(event:WorkerEvent)=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);}} as unknown as LauncherApi;});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
const render=async(id="a")=>act(async()=>root.render(<LauncherSearch state={state(id)} hasLastServer={false} onClose={vi.fn()} onExecute={vi.fn()}/>));
async function query(value:string){await act(async()=>{const input=document.querySelector<HTMLInputElement>('[role="combobox"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});}

it("keeps favorites/settings searchable after catalog failure without requests on typing",async()=>{
 window.mados.invoke=vi.fn(async()=>{throw Error("offline");}) as LauncherApi["invoke"];
 await render();expect(document.querySelector('.search-source-status')?.textContent).toContain("недоступен");
 await query("favorite");expect(document.querySelector('[role="option"]')?.textContent).toContain("Favorite a");
 await query("анимации");expect(document.querySelector('[role="option"]')?.textContent).toContain("Уменьшить движение");
 expect(window.mados.invoke).toHaveBeenCalledOnce();expect(window.mados.invoke).toHaveBeenCalledWith("servers.list");
});

it("does not replace a fresh catalog event with an older RPC reply",async()=>{
 const pending=deferred<ServerListResult>();window.mados.invoke=vi.fn(()=>pending.promise) as LauncherApi["invoke"];
 await render();await act(async()=>{listeners.forEach(fn=>fn({v:1,event:"servers.updated",data:catalog("New snapshot",2)}));});
 await act(async()=>pending.resolve(catalog("Old snapshot",1)));
 await query("snapshot");expect(document.querySelector('[role="option"]')?.textContent).toContain("New snapshot");expect(document.body.textContent).not.toContain("Old snapshot");
});

it("discards late profile replies when the active account changes",async()=>{
 const a=deferred<LaunchProfile[]>(),b=deferred<LaunchProfile[]>();window.mados.launchProfiles.list=vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
 await render("a");await render("b");await act(async()=>b.resolve([profile("b")]));await act(async()=>a.resolve([profile("a")]));
 await query("profile");expect(document.querySelector('[role="option"]')?.textContent).toContain("Profile b");expect(document.body.textContent).not.toContain("Profile a");
 await query("favorite");expect(document.querySelector('[role="option"]')?.textContent).toContain("Favorite b");
});

it("clears only the recovered source error after profile and catalog events",async()=>{
 window.mados.invoke=vi.fn(async()=>{throw Error("offline");}) as LauncherApi["invoke"];
 window.mados.launchProfiles.list=vi.fn().mockRejectedValueOnce(Error("profiles offline")).mockResolvedValueOnce([profile("recovered")]);
 await render();expect(document.querySelector('.search-source-status')?.textContent).toContain("профили");
 await act(async()=>listeners.forEach(fn=>fn({v:1,event:"launchProfiles.updated",data:{}})));
 expect(document.querySelector('.search-source-status')?.textContent).not.toContain("Не удалось загрузить профили");
 expect(document.querySelector('.search-source-status')?.textContent).toContain("Каталог недоступен");
 await act(async()=>listeners.forEach(fn=>fn({v:1,event:"servers.updated",data:catalog("Recovered server",2)})));
 expect(document.querySelector('.search-source-status')).toBeNull();await query("recovered");expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
});
