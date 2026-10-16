// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LauncherGuide, GUIDE_STORAGE_KEY, useLauncherGuide } from "./LauncherGuide";
it("allows skipping when local storage is unavailable and restores keyboard focus",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);localStorage.clear();const host=document.createElement("div");host.id="root";document.body.append(host);const root=createRoot(host);
  function Fixture(){const guide=useLauncherGuide(false);return <><button onClick={()=>guide.setOpen(true)}>Help</button>{guide.error&&<p role="alert">{guide.error}</p>}{guide.open&&<LauncherGuide onClose={guide.close}/>}</>;}
  try{
    await act(async()=>root.render(<Fixture/>));host.querySelector('button')!.focus();await act(async()=>host.querySelector('button')!.click());
    vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw Error("quota");});
    await act(async()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
    expect(document.querySelector('.launcher-guide')).toBeNull();expect(document.activeElement).toBe(host.querySelector('button'));expect(host.querySelector('[role="alert"]')?.textContent).toContain("запомнить");
  }finally{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();}
});
it("opens once after login, persists skip and can be reopened from help",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);localStorage.clear();const host=document.createElement("div");host.id="root";document.body.append(host);const root=createRoot(host);
  function Fixture({ready=true}:{ready?:boolean}){const guide=useLauncherGuide(ready);return <><button onClick={()=>guide.setOpen(true)}>Справка</button>{guide.open&&<LauncherGuide onClose={guide.close}/>}</>;}
  try{
    await act(async()=>root.render(<Fixture ready={false}/>));expect(document.querySelector('.launcher-guide')).toBeNull();
    await act(async()=>root.render(<Fixture/>));expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Найдите свою станцию");
    await act(async()=>document.querySelector<HTMLButtonElement>('[data-action="skip-guide"]')!.click());expect(localStorage.getItem(GUIDE_STORAGE_KEY)).toBe("done");expect(document.querySelector('.launcher-guide')).toBeNull();
    await act(async()=>root.render(<Fixture ready={false}/>));await act(async()=>root.render(<Fixture/>));expect(document.querySelector('.launcher-guide')).toBeNull();
    await act(async()=>host.querySelector('button')!.click());expect(document.querySelector('.launcher-guide')).not.toBeNull();
    for(let i=0;i<4;i++)await act(async()=>document.querySelector<HTMLButtonElement>('[data-action="guide-next"]')!.click());
    expect(document.querySelector('.launcher-guide')).toBeNull();expect(host.inert).toBe(false);
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
