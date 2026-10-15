// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ActionMenu } from "./ActionMenu";

it("navigates enabled actions, dismisses on Escape and reports async errors", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), selected = vi.fn(), error = vi.fn();
  try {
    await act(async () => root.render(<ActionMenu label="Действия сервера" onError={error} items={[
      {id:"folder",label:"Открыть папку",onSelect:selected},
      {id:"remove",label:"Удалить",disabled:true,onSelect:()=>{throw Error("Disabled action executed")}},
      {id:"log",label:"Открыть лог",onSelect:async()=>{throw Error("Лог недоступен")}},
    ]} />));
    const trigger = host.querySelector<HTMLButtonElement>("button")!; trigger.focus();
    await act(async () => trigger.click());
    expect(document.activeElement?.textContent).toContain("Открыть папку");
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})));
    expect(document.activeElement?.textContent).toContain("Открыть лог");
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger); expect(selected).not.toHaveBeenCalled();
    await act(async () => trigger.click());
    await act(async () => document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[2].click());
    expect(error).toHaveBeenCalledWith("Лог недоступен");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("dismisses when another overlay takes focus without stealing it back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), search = document.createElement("input"); document.body.append(search);
  try {
    await act(async () => root.render(<ActionMenu label="Действия сервера" onError={vi.fn()} items={[
      {id:"folder",label:"Открыть папку",onSelect:vi.fn()},
    ]} />));
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => search.focus());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(search);
  } finally { await act(async () => root.unmount()); host.remove(); search.remove(); vi.unstubAllGlobals(); }
});
