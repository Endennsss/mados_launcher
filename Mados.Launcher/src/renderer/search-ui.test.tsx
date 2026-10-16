// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandPalette, buildCommandPaletteCommands } from "./CommandPalette";

let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host=document.createElement("div");document.body.append(host);root=createRoot(host); });
afterEach(async () => { await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals(); });
const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
async function type(value:string) { await act(async()=>{ Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input(),value);input().dispatchEvent(new Event("input",{bubbles:true})); }); }
async function key(value:string) { await act(async()=>input().dispatchEvent(new KeyboardEvent("keydown",{key:value,bubbles:true}))); }

it("searches settings with a combobox, previews the selected target and executes it using Enter",async()=>{
 const execute=vi.fn();await act(async()=>root.render(<CommandPalette commands={buildCommandPaletteCommands()} onClose={vi.fn()} onExecute={execute}/>));
 expect(input()).not.toBeNull();await type("анимации");
 expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
 const option=document.querySelector('[role="option"]')!;
 expect(input().getAttribute("aria-activedescendant")).toBe(option.id);
 expect(document.querySelector('.search-preview')?.textContent).toContain("Уменьшить движение");
 await key("Enter");expect(execute).toHaveBeenCalledWith({type:"open-setting",settingId:"motion"});
});

it("supports Home/End, gives an empty result without executing and restores focus on dismissal",async()=>{
 const execute=vi.fn();const trigger=document.createElement("button");document.body.append(trigger);trigger.focus();
 const commands=buildCommandPaletteCommands();
 await act(async()=>root.render(<CommandPalette commands={commands} onClose={vi.fn()} onExecute={execute}/>));
 await key("End");expect(document.querySelectorAll('[role="option"]')[commands.length-1].getAttribute("aria-selected")).toBe("true");
 await key("Home");expect(document.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe("true");
 await type("nothing-matches-this");expect(input().hasAttribute("aria-activedescendant")).toBe(false);await key("Enter");expect(execute).not.toHaveBeenCalled();
 await act(async()=>root.render(<CommandPalette open={false} onClose={vi.fn()}/>));
 expect(document.querySelector('[role="dialog"]')).toBeNull();
 expect(document.activeElement).toBe(trigger);trigger.remove();
});
