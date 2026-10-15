import { describe, expect, it } from "vitest";
import { launchPercent, reduceLaunchEvent } from "./launch-status";
import type { WorkerEvent } from "../contracts/launcher";

const event = (name: string, data: unknown): WorkerEvent => ({ v: 1, event: name, data });

describe("launch activity driven by worker events", () => {
  it("keeps the target through download completion and only times ClientRunning", () => {
    let state = reduceLaunchEvent(null, event("connection.started", { address: "ss14://station.example?token=private", name: "Station" }), 1000);
    state = reduceLaunchEvent(state, event("update.progress", { status: "DownloadingClientUpdate", progress: { downloaded: 50, total: 200 } }), 2000);
    expect(state).toMatchObject({ name: "Station", address: "ss14://station.example", startedAt: null });
    expect(launchPercent(state!.progress)).toBe(25);
    state = reduceLaunchEvent(state, event("update.completed", { status: "Ready" }), 3000);
    expect(state).not.toBeNull();
    state = reduceLaunchEvent(state, event("connection.progress", { status: "ClientRunning" }), 4000);
    state = reduceLaunchEvent(state, event("connection.completed", { status: "ClientRunning" }), 8000);
    expect(state).toMatchObject({ status: "ClientRunning", startedAt: 4000 });
    expect(reduceLaunchEvent(state, event("update.progress", { status: "Ready" }), 9000)).toEqual(state);
    expect(reduceLaunchEvent(state, event("connection.progress", { status: "ClientExited" }), 10000)).toBeNull();
  });

  it("keeps errors visible and resets them when another attempt starts", () => {
    let state = reduceLaunchEvent(null, event("connection.failed", { status: "UpdateError", message: "Download failed" }));
    expect(state).toMatchObject({ status: "UpdateError", reason: "Download failed" });
    state = reduceLaunchEvent(state, event("connection.started", { path: "replay.zip", contentBundle: true }));
    expect(state).toMatchObject({ contentBundle: true, name: "replay.zip", reason: null, startedAt: null });
  });

  it("does not invent progress when byte totals are unknown or invalid", () => {
    expect(launchPercent({ downloaded: 80, total: 0 })).toBeNull();
    expect(launchPercent({ downloaded: Number.NaN, total: 100 })).toBeNull();
    expect(launchPercent({ downloaded: 0, total: 100 })).toBe(0);
    expect(launchPercent({ downloaded: 120, total: 100 })).toBe(100);
  });
});
