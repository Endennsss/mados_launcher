// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LaunchProfiles } from "./LaunchProfiles";
it("restores keyboard focus after a deferred save enables the opener",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const host=document.createElement("div");document.body.append(host);const root=createRoot(host);let finish!:()=>void;
  const profile={id:"p",name:"Вечерняя",address:"ss14://alpha",createdAt:"",lastUsedAt:null};
  try{
    await act(async()=>root.render(<LaunchProfiles profiles={[profile]} onCreate={()=>{}} onUpdate={()=>new Promise<void>(resolve=>{finish=resolve;})} onUse={()=>{}} onRemove={()=>{}}/>));
    const opener=host.querySelector<HTMLButtonElement>('[aria-label="Изменить профиль Вечерняя"]')!;opener.focus();await act(async()=>opener.click());
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));expect(opener.disabled).toBe(true);
    await act(async()=>finish());expect(opener.disabled).toBe(false);expect(document.activeElement).toBe(opener);
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
it("keeps a rejected inline edit open and lets the user retry the same draft",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  let reject=true;const update=async()=>{if(reject)throw Error("Не удалось сохранить профиль");};
  const profile={id:"p",name:"Вечерняя",address:"ss14://alpha",createdAt:"2026-10-16T00:00:00Z",lastUsedAt:null};
  try{
    await act(async()=>root.render(<LaunchProfiles profiles={[profile]} onCreate={async()=>{}} onUpdate={update} onUse={async()=>{}} onRemove={async()=>{}}/>));
    expect(host.querySelector('.launch-profile-form')).toBeNull();
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Изменить профиль Вечерняя"]')!.click());
    expect(host.querySelector('.launch-profile-card .launch-profile-form')).not.toBeNull();
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Не удалось сохранить профиль");
    expect(host.querySelector<HTMLInputElement>('input')?.value).toBe("Вечерняя");
    reject=false;await act(async()=>host.querySelector('form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(host.querySelector('form')).toBeNull();expect(host.textContent).toContain("Профиль сохранён");
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Изменить профиль Вечерняя"]'));
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
