import { describe, expect, it } from "vitest";
import { defaultHomeLayout, normalizeHomeLayout, moveHomeBlock, orderHomeFavorites, parseCompletedSession } from "./home-personalization";

describe("account home preferences", () => {
  it("repairs stale layouts, removes unknown blocks and strips credentials from pinned addresses", () => {
    const layout = normalizeHomeLayout({ version: 1, order: ["recent", "recent", "missing"], hidden: ["week", "missing"], pinned: ["ss14://name:secret@station.test/?token=secret", "file:///tmp"] });
    expect(layout.order).toEqual(["recent", ...defaultHomeLayout().order.filter(id => id !== "recent")]);
    expect(layout.hidden).toEqual(["week"]);
    expect(layout.pinned).toEqual(["ss14://station.test"]);
    expect(normalizeHomeLayout({ version: 99 })).toEqual(defaultHomeLayout());
  });
  it("moves blocks in both directions without dropping other blocks", () => {
    const order = defaultHomeLayout().order;
    expect(moveHomeBlock(order, order[0], order[2])).toEqual([order[1], order[2], order[0], ...order.slice(3)]);
    expect(moveHomeBlock(order, order[2], order[0])).toEqual([order[2], order[0], order[1], ...order.slice(3)]);
  });
  it("pins only existing favorites and keeps the rest in their original order", () => {
    const a = { address: "ss14://a.test", name: "A", raiseTime: "" }, b = { address: "ss14://b.test/", name: "B", raiseTime: "" };
    expect(orderHomeFavorites([a, b], ["ss14://gone.test", "ss14://b.test"])).toEqual([b, a]);
  });
});

describe("completed game sessions", () => {
  const event = { accountId: "a", address: "ss14://name:secret@station.test?token=secret", name: "Station", startedAt: "2026-10-15T12:00:00Z", elapsedSeconds: 3720, active: false };
  it("uses exactly the worker duration and sanitizes the address", () => {
    expect(parseCompletedSession(event, "a")).toMatchObject({ elapsedSeconds: 3720, address: "ss14://station.test", name: "Station" });
  });
  it("rejects heartbeat, history-clear, other-account and malformed events", () => {
    for (const data of [null, { cleared: 1, accountId: "a" }, { ...event, active: true }, { ...event, accountId: "b" }, { ...event, elapsedSeconds: -1 }, { ...event, elapsedSeconds: Infinity }, { ...event, startedAt: "no date" }, { ...event, address: "file:///replay.zip" }]) {
      expect(parseCompletedSession(data, "a")).toBeNull();
    }
  });
});
