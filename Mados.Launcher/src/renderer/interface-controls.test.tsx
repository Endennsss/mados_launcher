// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmProvider, useConfirm } from "./ConfirmDialog";
import { SelectField } from "./SelectField";
import { TooltipLayer } from "./TooltipLayer";

let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const key = async (key: string) => act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

it("select supports keyboard choice, Escape without change and focus return", async () => {
  function Fixture() { const [value, setValue] = useState("players"); return <SelectField label="Сортировка" value={value} onChange={setValue} options={[{value:"players",label:"По онлайну"},{value:"name",label:"По названию"}]} />; }
  await act(async () => root.render(<Fixture />));
  const trigger = host.querySelector<HTMLButtonElement>("button")!; trigger.focus();
  await key("ArrowDown");
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  await key("End"); await key("Enter");
  expect(trigger.textContent).toContain("По названию"); expect(document.activeElement).toBe(trigger);
  await key("ArrowDown"); await key("Home"); await key("Escape");
  expect(trigger.textContent).toContain("По названию"); expect(document.activeElement).toBe(trigger);
});

it("confirmation cancels on Escape, traps focus and resolves only after an explicit decision", async () => {
  const result = vi.fn();
  function Fixture() { const confirm = useConfirm(); return <button onClick={async () => result(await confirm({title:"Удалить историю?",message:"Только текущего аккаунта.",confirmLabel:"Удалить"}))}>Очистить</button>; }
  await act(async () => root.render(<ConfirmProvider><Fixture /></ConfirmProvider>));
  const trigger = host.querySelector<HTMLButtonElement>("button")!; trigger.focus();
  await act(async () => trigger.click());
  expect(result).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Только текущего аккаунта.");
  await key("Escape"); expect(result).toHaveBeenLastCalledWith(false); expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  const buttons = document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button');
  buttons[buttons.length - 1].focus(); await key("Tab"); expect(document.activeElement).toBe(buttons[0]);
  await act(async () => buttons[buttons.length - 1].click()); expect(result).toHaveBeenLastCalledWith(true);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

it("tooltip preserves an existing description and removes its own reference on dismissal", async () => {
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<><button data-tooltip="Обновить список" aria-describedby="existing">Обновить</button><TooltipLayer /></>));
    const button = host.querySelector<HTMLButtonElement>("button")!;
    await act(async () => { button.focus(); vi.advanceTimersByTime(150); });
    const tooltip = document.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toBe("Обновить список");
    expect(button.getAttribute("aria-describedby")).toContain("existing");
    await key("Escape");
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBe("existing");
  } finally { vi.useRealTimers(); }
});

it("confirmation cancels when its initiating account changes or its screen unmounts", async () => {
  const result = vi.fn();
  function Fixture({ account }: { account: string }) {
    const confirm = useConfirm(account);
    return <button onClick={async () => result(await confirm("Удалить историю?"))}>Очистить</button>;
  }
  const render = (account: string | null) => act(async () => root.render(<ConfirmProvider>{account && <Fixture account={account} />}</ConfirmProvider>));
  await render("first");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  await render("second");
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(result).toHaveBeenLastCalledWith(false);
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  await render(null);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(result).toHaveBeenCalledTimes(2);
  expect(result).toHaveBeenLastCalledWith(false);
});
