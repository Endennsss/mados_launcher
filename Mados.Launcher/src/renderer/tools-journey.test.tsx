// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { LauncherApi } from "../contracts/launcher";
import { ConfirmProvider } from "./ConfirmDialog";
import { ToolsView } from "./ToolsView";

it.each(["config", "backups"])("keeps Stop available when loading %s fails for a running server",async(failed)=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const stop=vi.fn(async()=>({profileId:"a",status:"stopped"}));
  window.mados={onEvent:()=>()=>{},localServers:{list:async()=>[{id:"a",name:"Alpha",port:1212}],getStatus:async()=>({profileId:"a",status:"running",pid:42}),getConfig:async()=>{if(failed==="config")throw Error("Invalid TOML");return {name:"Alpha",port:1212,rawToml:"[net]"};},backups:async()=>{if(failed==="backups")throw Error("Cannot read backups");return [];},stop}} as unknown as LauncherApi;
  try{
    await act(async()=>root.render(<ConfirmProvider><ToolsView onError={()=>{}}/></ConfirmProvider>));
    const button=host.querySelector<HTMLButtonElement>('.local-server-primary')!;expect(button.textContent).toContain('Остановить');expect(button.disabled).toBe(false);
    await act(async()=>button.click());await act(async()=>document.querySelector<HTMLButtonElement>('[role="alertdialog"] .primary-button')!.click());expect(stop).toHaveBeenCalledWith('a');
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

it("preserves configuration across steps, blocks stale-config launch and moves to Run after a successful save",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const config={name:"Alpha",port:1212,rawToml:"[net]",bindAddress:"127.0.0.1"};let reject=true;const start=vi.fn();
  window.mados={onEvent:()=>()=>{},localServers:{list:async()=>[{id:"a",name:"Alpha",port:1212,bindAddress:"127.0.0.1",version:"v1"}],getStatus:async()=>({profileId:"a",status:"stopped"}),getConfig:async()=>config,backups:async()=>[],start,saveConfig:async(_id:string,draft:unknown)=>{if(reject)throw Error("Не удалось сохранить");return draft;}}} as unknown as LauncherApi;
  const click=async(selector:string)=>act(async()=>host.querySelector<HTMLButtonElement>(selector)!.click());
  try{
    await act(async()=>root.render(<ConfirmProvider><ToolsView onError={()=>{}}/></ConfirmProvider>));
    expect(host.querySelector('[data-tools-step="run"]')?.getAttribute('aria-current')).toBe('step');await click('[data-tools-step="config"]');
    const input=host.querySelector<HTMLInputElement>('.tool-config-card input')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'New name');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await click('[data-tools-step="run"]');expect(host.querySelector<HTMLButtonElement>('.local-server-primary')!.disabled).toBe(true);expect(host.querySelector('.tools-draft-notice')?.textContent).toContain('Несохранённые');
    await click('[data-tools-step="config"]');expect(input.value).toBe('New name');await click('[data-action="save-config-next"]');expect(host.querySelector('[data-tools-step="config"]')?.getAttribute('aria-current')).toBe('step');expect(input.value).toBe('New name');
    reject=false;await click('[data-action="save-config-next"]');expect(host.querySelector('[data-tools-step="run"]')?.getAttribute('aria-current')).toBe('step');expect(host.querySelector<HTMLButtonElement>('.local-server-primary')!.disabled).toBe(false);expect(start).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

it("moves a completed ZIP import to configuration without starting a process",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const host=document.createElement("div");document.body.append(host);const root=createRoot(host);let installed=false;
  const profile={id:"new",name:"New server",port:1212,bindAddress:"127.0.0.1"},start=vi.fn();
  window.mados={onEvent:()=>()=>{},pickLocalServerArchive:async()=>"D:/build.zip",tools:{cdnImport:async()=>{installed=true;return {profile};}},localServers:{list:async()=>installed?[profile]:[],getStatus:async()=>({profileId:"new",status:"ready"}),getConfig:async()=>({name:"New server",port:1212,rawToml:"[net]"}),backups:async()=>[],start}} as unknown as LauncherApi;
  try{
    await act(async()=>root.render(<ConfirmProvider><ToolsView onError={()=>{}}/></ConfirmProvider>));expect(host.querySelector('[data-tools-step="build"]')?.getAttribute('aria-current')).toBe('step');
    await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.tool-import-card button')].find(b=>b.textContent?.includes('Выбрать ZIP'))!.click());
    await act(async()=>host.querySelector<HTMLButtonElement>('.tool-import-card .primary-button')!.click());expect(host.querySelector('[data-tools-step="config"]')?.getAttribute('aria-current')).toBe('step');expect(start).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
it("asks before an import can replace the selected configuration draft",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const importBuild=vi.fn(async()=>({profile:{id:"b"}}));
  window.mados={onEvent:()=>()=>{},pickLocalServerArchive:async()=>"D:/build.zip",tools:{cdnImport:importBuild},localServers:{list:async()=>[{id:"a",name:"Alpha",port:1212}],getStatus:async()=>({profileId:"a",status:"stopped"}),getConfig:async()=>({name:"Alpha",port:1212,rawToml:"[net]"}),backups:async()=>[]}} as unknown as LauncherApi;
  try{
    await act(async()=>root.render(<ConfirmProvider><ToolsView onError={()=>{}}/></ConfirmProvider>));await act(async()=>host.querySelector<HTMLButtonElement>('[data-tools-step="config"]')!.click());const input=host.querySelector<HTMLInputElement>('.tool-config-card input')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Draft');input.dispatchEvent(new Event('input',{bubbles:true}));});await act(async()=>host.querySelector<HTMLButtonElement>('[data-tools-step="build"]')!.click());
    await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.tool-import-card button')].find(b=>b.textContent?.includes('Выбрать ZIP'))!.click());await act(async()=>host.querySelector<HTMLButtonElement>('.tool-import-card .primary-button')!.click());
    expect(importBuild).not.toHaveBeenCalled();expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Несохранённые');await act(async()=>document.querySelector<HTMLButtonElement>('[role="alertdialog"] .secondary-button')!.click());expect(input.value).toBe('Draft');
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
