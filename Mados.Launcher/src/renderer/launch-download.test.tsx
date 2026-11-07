// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LaunchDock } from "./LaunchDock";
import { reduceLaunchEvent, type LaunchActivity } from "./launch-status";

it("shows download amounts in bytes or files and clears them at the next stage", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const initial: LaunchActivity = { status: "Connecting", name: "Station", address: null, contentBundle: false, startedAt: null };
  const render = async (progress: unknown) => {
    const activity = reduceLaunchEvent(initial, { v: 1, event: "update.progress", data: { status: "DownloadingClientUpdate", progress } })!;
    await act(async () => root.render(<LaunchDock activity={activity} onDismiss={() => {}} />));
  };
  try {
    await render({ downloaded: 5242880, total: 20971520, unit: "Bytes" });
    expect(host.textContent).toContain("5 МБ / 20 МБ");
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("25");
    expect(host.querySelector<HTMLElement>('[role="progressbar"] > span')?.style.width).toBe("25%");
    await render({ downloaded: 30, total: 120, unit: "None" });
    expect(host.textContent).toContain("30 / 120 файлов");
    expect(host.textContent).not.toContain("МБ");
    await render({ downloaded: 5242880, total: 0, unit: "Bytes" });
    expect(host.textContent).toContain("5 МБ");
    expect(host.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
    await act(async () => root.render(<LaunchDock activity={{ ...initial, status: "StartingClient" }} onDismiss={() => {}} />));
    expect(host.textContent).not.toContain("МБ");
    expect(host.textContent).not.toContain("файлов");
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  }
});
