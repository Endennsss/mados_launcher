// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { LauncherApi } from "../contracts/launcher";
import { useLaunchProfiles } from "./useLaunchProfiles";
import { AccountSwitcher } from "./AccountSwitcher";
it("invalidates a profile launch as soon as switching starts, before the account reply",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  let state!:ReturnType<typeof useLaunchProfiles>,finish!:(value:unknown)=>void,finishSwitch!:()=>void;
  const profile={id:"p",name:"Old",address:"ss14://old",createdAt:"",lastUsedAt:null};let connections=0;let outcome:unknown;
  const accounts=[{id:"a",username:"A",active:true,status:"available" as const},{id:"b",username:"B",active:false,status:"available" as const}];
  const accountState={ready:true,loggedIn:true,version:"test",activeAccount:accounts[0],accounts,favorites:[]};
  window.mados={launchProfiles:{list:async()=>[profile],use:()=>new Promise(resolve=>{finish=resolve;})},onEvent:()=>()=>{},invoke:async(method:string)=>{if(method==='auth.switchAccount')await new Promise<void>(resolve=>{finishSwitch=resolve;});if(method==='servers.connect')connections++;return accountState;}} as unknown as LauncherApi;
  function Fixture(){state=useLaunchProfiles("a",async()=>true);return <AccountSwitcher state={accountState} onStateChange={()=>{}} onAddAccount={()=>{}} onReauthenticate={()=>{}}/>;}
  try{
    await act(async()=>root.render(<Fixture/>));await act(async()=>{void state.launch("p").catch(error=>{outcome=error;});});
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Аккаунты"]')!.click());await act(async()=>document.querySelector<HTMLButtonElement>('[data-account-id="b"]')!.click());
    await act(async()=>finish(profile));expect(connections).toBe(0);expect(outcome).toBeInstanceOf(Error);
  }finally{if(finishSwitch)await act(async()=>finishSwitch());await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
it("rejects an old account's pending launch without connecting or replacing the new list",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  let state!:ReturnType<typeof useLaunchProfiles>,finish!:(value:unknown)=>void;
  const old={id:"a-profile",name:"Old",address:"ss14://old",createdAt:"",lastUsedAt:null};
  let current=old,connections=0;
  window.mados={launchProfiles:{list:async()=>[current],use:()=>new Promise(resolve=>{finish=resolve;})},onEvent:()=>()=>{},invoke:async()=>{connections++;}} as unknown as LauncherApi;
  function Fixture({id}:{id:string}){state=useLaunchProfiles(id,async()=>true);return <span>{state.profiles.map(p=>p.name).join(",")}</span>;}
  try{
    await act(async()=>root.render(<Fixture id="a"/>));let outcome:unknown;
    await act(async()=>{void state.launch(old.id).catch(error=>{outcome=error;});});
    current={...old,id:"b-profile",name:"New",address:"ss14://new"};await act(async()=>root.render(<Fixture id="b"/>));
    await act(async()=>finish(old));expect(connections).toBe(0);expect(host.textContent).toBe("New");expect(outcome).toBeInstanceOf(Error);
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
