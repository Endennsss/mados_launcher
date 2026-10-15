// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { LauncherApi, ShellUpdateState } from "../contracts/launcher";
import { LauncherUpdateView } from "./LauncherUpdateView";

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
