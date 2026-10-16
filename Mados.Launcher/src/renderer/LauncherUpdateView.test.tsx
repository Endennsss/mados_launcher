// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { LauncherApi, ShellUpdateState } from "../contracts/launcher";
import { LauncherUpdateView } from "./LauncherUpdateView";

it("keeps release links usable while the manual download promise is pending",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  let complete!:()=>void;const openExternal=vi.fn(async()=>undefined);
  window.mados={downloadUpdate:vi.fn(()=>new Promise<void>(resolve=>{complete=resolve;})),openExternal} as unknown as LauncherApi;
  try{
    await act(async()=>root.render(<LauncherUpdateView expanded update={{status:"available",currentVersion:"0.41.0",version:"0.42.0",revision:1,releaseNotes:"[Подробности](https://github.com/Endennsss/mados_launcher/releases)"}}/>));
    await act(async()=>host.querySelector<HTMLButtonElement>('.update-controls .primary-button')!.click());
    await act(async()=>host.querySelector<HTMLButtonElement>('.release-inline-link')!.click());
    expect(openExternal).toHaveBeenCalledTimes(1);
  }finally{await act(async()=>complete?.());await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

it("shows real notes, versions and byte progress without downloading on open",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const downloadUpdate=vi.fn();window.mados={downloadUpdate} as unknown as LauncherApi;
  try{
    await act(async()=>root.render(<LauncherUpdateView expanded update={{status:"downloading",currentVersion:"0.41.0",version:"0.42.0",revision:2,percent:25,transferred:1048576,total:4194304,bytesPerSecond:1048576,releaseNotes:"## Изменения\n\nНовые карточки сервера"}}/>));
    expect(host.querySelector('.update-versions')?.textContent).toContain("0.41.0");
    expect(host.querySelector('.update-versions')?.textContent).toContain("0.42.0");
    expect(host.querySelector('.update-release-notes')?.textContent).toContain("Новые карточки сервера");
    expect(host.querySelector('.update-transfer')?.textContent).toContain("1 МБ из 4 МБ");
    expect(downloadUpdate).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

it("waits for download consent and disables restart while a game is active", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host=document.createElement("div"); document.body.append(host); const root=createRoot(host);
  const downloadUpdate=vi.fn(async()=>undefined), installUpdate=vi.fn();
  window.mados={downloadUpdate,installUpdate} as unknown as LauncherApi;
  let state: ShellUpdateState={status:"available",currentVersion:"0.40.3",version:"0.41.0",revision:1};
  try {
    await act(async()=>root.render(<LauncherUpdateView update={state} />));
    expect(downloadUpdate).not.toHaveBeenCalled();
    await act(async()=>host.querySelector<HTMLButtonElement>(".primary-button")!.click());
    expect(downloadUpdate).toHaveBeenCalledTimes(1); expect(installUpdate).not.toHaveBeenCalled();
    state={...state,status:"downloading",percent:52,revision:2};
    await act(async()=>root.render(<LauncherUpdateView update={state} />));
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("52");
    state={...state,status:"downloaded",revision:3};
    await act(async()=>root.render(<LauncherUpdateView update={state} launchBusy />));
    expect(host.querySelector<HTMLButtonElement>(".primary-button")!.disabled).toBe(true);
    await act(async()=>root.render(<LauncherUpdateView update={state} />));
    await act(async()=>host.querySelector<HTMLButtonElement>(".primary-button")!.click());
    expect(installUpdate).toHaveBeenCalledTimes(1);
  } finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

it("keeps check failures actionable without an unhandled IPC rejection",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  window.mados={checkForUpdates:vi.fn(async()=>{throw Error("closed")})} as unknown as LauncherApi;
  try{
    await act(async()=>root.render(<LauncherUpdateView update={{status:"error",currentVersion:"0.40.3",revision:1}} expanded />));
    await act(async()=>host.querySelector<HTMLButtonElement>(".secondary-button")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Повторите попытку");
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
