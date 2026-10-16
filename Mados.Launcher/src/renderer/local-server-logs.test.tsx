// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LocalServerLogs } from "./LocalServerLogs";
import type { LocalServerLogLine } from "../contracts/launcher";
it("keeps collecting while scroll is paused and filters real errors without losing other lines",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  let lines:LocalServerLogLine[]=[{profileId:"a",timestamp:new Date().toISOString(),line:"Server ready",stream:"stdout"}];
  const render=()=>act(async()=>root.render(<LocalServerLogs profileId="a" name="Alpha" lines={lines} onSave={async()=>{throw Error("Запись не удалась");}} onClear={()=>{}}/>));
  const click=async(selector:string)=>act(async()=>host.querySelector<HTMLButtonElement>(selector)!.click());
  try{
    await render();expect(host.querySelector('.tool-log-view')).toBeNull();await click('[data-action="toggle-server-logs"]');const view=host.querySelector<HTMLElement>('.tool-log-view')!;
    Object.defineProperty(view,'scrollHeight',{value:1000,configurable:true});await click('[aria-label="Приостановить автопрокрутку"]');view.scrollTop=20;
    lines=[...lines,{...lines[0],line:"[ERRO] bind failed",stream:"stderr"}];await render();expect(view.scrollTop).toBe(20);expect(view.textContent).toContain('bind failed');
    await click('[data-log-filter="errors"]');expect(view.textContent).not.toContain('Server ready');expect(view.querySelector('.log-error')).not.toBeNull();await click('[data-log-filter="all"]');expect(view.textContent).toContain('Server ready');
    await click('[aria-label="Включить автопрокрутку"]');expect(view.scrollTop).toBe(1000);await click('[aria-label="Сохранить лог"]');expect(host.querySelector('[role="alert"]')?.textContent).toContain('Запись не удалась');
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
