// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LauncherApi, LauncherState } from "../contracts/launcher";
import { AccountSwitcher } from "./AccountSwitcher";
import { ThemePicker, useLauncherTheme } from "./ThemePicker";

let host: HTMLDivElement, root: Root;
const a = { id: "a", username: "Ende", active: true, status: "available" };
const b = { id: "b", username: "Pilot", active: false, status: "available" };
const expired = { id: "expired", username: "Old Pilot", active: false, status: "expired" };
const state = { ready: true, loggedIn: true, activeAccount: a, accounts: [a, b, expired], favorites: [], version: "test" } as LauncherState;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  window.mados = { invoke: vi.fn() } as unknown as LauncherApi;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete document.documentElement.dataset.theme; });
async function click(selector: string) { const button = document.querySelector<HTMLButtonElement>(selector); expect(button, selector).not.toBeNull(); await act(async () => button!.click()); }
async function key(value: string) { await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }))); }

it("opens an accessible account panel with real account statuses and restores focus on Escape", async () => {
  await act(async () => root.render(<AccountSwitcher state={state} onStateChange={vi.fn()} onAddAccount={vi.fn()} onReauthenticate={vi.fn()} />));
  await click('[aria-label="Аккаунты"]');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Сессия истекла");
  expect(document.querySelector('[data-account-id="a"]')?.textContent).toContain("Активен");
  await key("Escape");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('[aria-label="Аккаунты"]'));
});

it("switches through the worker once, waits for the result, and keeps errors actionable", async () => {
  let reject!: (reason: Error) => void;
  const invoke = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
  window.mados.invoke = invoke as LauncherApi["invoke"];
  const changed = vi.fn();
  await act(async () => root.render(<AccountSwitcher state={state} onStateChange={changed} onAddAccount={vi.fn()} onReauthenticate={vi.fn()} />));
  await click('[aria-label="Аккаунты"]'); await click('[data-account-id="b"]'); await click('[data-account-id="b"]');
  expect(invoke).toHaveBeenCalledOnce(); expect(invoke).toHaveBeenCalledWith("auth.switchAccount", { accountId: "b" });
  expect(changed).not.toHaveBeenCalled();
  expect(document.querySelector('[data-account-id="b"]')?.textContent).toContain("Переключаем");
  await act(async () => reject(new Error("Нет связи с worker")));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Нет связи с worker");
  expect(document.querySelector<HTMLButtonElement>('[data-account-id="b"]')?.disabled).toBe(false);
  const next = { ...state, activeAccount: { ...b, active: true }, accounts: [ { ...a, active: false }, { ...b, active: true }, expired ] };
  window.mados.invoke = vi.fn(async method => method === "app.getState" ? next : b) as LauncherApi["invoke"];
  await click('[data-account-id="b"]'); expect(changed).toHaveBeenCalledWith(next);
});

it("reauthenticates an expired account without switching the active one, and keeps add/logout available", async () => {
  const login = vi.fn(), add = vi.fn(), changed = vi.fn();
  window.mados.invoke = vi.fn(async () => ({ ...state, activeAccount: b })) as LauncherApi["invoke"];
  await act(async () => root.render(<AccountSwitcher state={state} onStateChange={changed} onAddAccount={add} onReauthenticate={login} />));
  await click('[aria-label="Аккаунты"]'); await click('[data-account-id="expired"]');
  expect(login).toHaveBeenCalledWith(expired); expect(window.mados.invoke).not.toHaveBeenCalled();
  await click('[aria-label="Аккаунты"]'); await click('[data-action="add-account"]'); expect(add).toHaveBeenCalledOnce();
  await click('[aria-label="Аккаунты"]'); await click('[data-action="logout"]');
  expect(window.mados.invoke).toHaveBeenCalledWith("auth.logout", { accountId: "a" });
});

it.each(['[data-account-id="b"]', '[data-action="logout"]'])("keeps keyboard focus inside the panel during and after a failed operation on %s", async selector => {
  let reject!: (reason: Error) => void;
  window.mados.invoke = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; })) as LauncherApi["invoke"];
  await act(async () => root.render(<AccountSwitcher state={state} onStateChange={vi.fn()} onAddAccount={vi.fn()} onReauthenticate={vi.fn()} />));
  await click('[aria-label="Аккаунты"]');
  document.querySelector<HTMLButtonElement>(selector)!.focus();
  await click(selector);
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Закрыть аккаунты"]')!;
  expect(document.activeElement).toBe(close);
  expect(close.disabled).toBe(false);
  await key("Escape");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click('[aria-label="Аккаунты"]');
  const reopenedClose = document.querySelector<HTMLButtonElement>('[aria-label="Закрыть аккаунты"]')!;
  expect(document.activeElement).toBe(reopenedClose);
  await act(async () => reject(new Error("Нет связи с worker")));
  expect(document.activeElement).toBe(reopenedClose);
  await key("Escape");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('[aria-label="Аккаунты"]'));
});

function Appearance() {
  const controller = useLauncherTheme();
  return <ThemePicker {...controller} />;
}

it("shows five interface previews and supports persistent selection, undo and returning to Mados", async () => {
  await act(async () => root.render(<Appearance />));
  expect(host.querySelectorAll('.theme-preview')).toHaveLength(5);
  await click('[role="radio"][data-theme-choice="ocean"]');
  expect(document.documentElement.dataset.theme).toBe("ocean"); expect(localStorage.getItem("mados.theme")).toBe("ocean");
  await click('[data-action="undo-theme"]'); expect(document.documentElement.dataset.theme).toBe("mados");
  expect(document.querySelector<HTMLButtonElement>('[data-action="undo-theme"]')?.disabled).toBe(true);
  await click('[data-theme-choice="violet"]'); await click('[data-action="reset-theme"]');
  expect(document.documentElement.dataset.theme).toBe("mados");
  await click('[data-action="undo-theme"]'); expect(document.documentElement.dataset.theme).toBe("violet");
});

it("supports keyboard theme selection and preserves the previous choice when storage is unavailable", async () => {
  localStorage.setItem("mados.theme", "amber");
  await act(async () => root.render(<Appearance />));
  const current = host.querySelector<HTMLButtonElement>('[data-theme-choice="amber"]')!; current.focus();
  await key("Home"); expect(document.documentElement.dataset.theme).toBe("mados");
  await key("ArrowRight"); expect(document.documentElement.dataset.theme).toBe("violet");
  expect(document.activeElement?.getAttribute('data-theme-choice')).toBe("violet");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
  await click('[data-theme-choice="emerald"]');
  expect(document.documentElement.dataset.theme).toBe("emerald");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("не сохранилась");
});

it("does not overwrite a newer account with a delayed state response", async () => {
  let resolve!: (state: LauncherState) => void;
  window.mados.invoke = vi.fn(method => method === "app.getState" ? new Promise<LauncherState>(done => { resolve = done; }) : Promise.resolve(b)) as LauncherApi["invoke"];
  const changed = vi.fn();
  const render = (next: LauncherState) => act(async () => root.render(<AccountSwitcher state={next} onStateChange={changed} onAddAccount={vi.fn()} onReauthenticate={vi.fn()} />));
  await render(state); await click('[aria-label="Аккаунты"]'); await click('[data-account-id="b"]');
  const c = { ...a, id: "c", username: "Other Pilot" };
  await render({ ...state, activeAccount: c, accounts: [c, b] });
  await act(async () => resolve({ ...state, activeAccount: b }));
  expect(changed).not.toHaveBeenCalled();
  expect(document.querySelector('.account-panel-identity')?.textContent).toContain('Other Pilot');
});
