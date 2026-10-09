import { describe, expect, it } from "vitest";
import { formatDelta, formatDurationSince, notificationUnreadCount, sparklinePoints } from "./monitoring";

describe("monitoring helpers", () => {
  it("formats ping and player deltas", () => {
    expect(formatDelta(12, " ms")).toBe("+12 ms");
    expect(formatDelta(-3, " игроков")).toBe("-3 игроков");
    expect(formatDelta(0)).toBe("—");
  });

  it("creates a stable sparkline and handles missing data", () => {
    expect(sparklinePoints([])).toBe("");
    expect(sparklinePoints([{ capturedAt: "", isOnline: true, pingMs: 42, playerCount: 1 }])).toBe("60.0,32.0");
    expect(sparklinePoints([
      { capturedAt: "", isOnline: true, pingMs: 20, playerCount: 1 },
      { capturedAt: "", isOnline: true, pingMs: 40, playerCount: 2 },
    ], 100, 20)).toBe("0.0,18.0 100.0,2.0");
  });

  it("formats relative times and unread notifications", () => {
    const now = Date.parse("2026-01-01T01:00:00.000Z");
    expect(formatDurationSince("2026-01-01T00:59:30.000Z", now)).toBe("только что");
    expect(formatDurationSince("2026-01-01T00:00:00.000Z", now)).toBe("1 ч назад");
    expect(notificationUnreadCount([
      { id: "1", kind: "game-update", title: "", message: "", createdAt: "", readAt: null },
      { id: "2", kind: "favorite-online", title: "", message: "", createdAt: "", readAt: "2026-01-01T00:00:00Z" },
    ])).toBe(1);
  });
});
