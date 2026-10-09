import { describe, expect, it } from "vitest";
import { sortRecentConnections, type RecentConnection } from "./recent-connections";

const recent = (address: string, lastConnectedAt: string, playerCount: number | null, pingMs: number | null): RecentConnection => ({
  address,
  name: address,
  lastConnectedAt,
  playerCount,
  pingMs,
});

describe("recent connection sorting", () => {
  it("places known ping values first and unknown values last", () => {
    const result = sortRecentConnections([
      recent("ss14://unknown", "2026-10-09T12:00:00Z", null, null),
      recent("ss14://slow", "2026-10-09T12:02:00Z", 2, 80),
      recent("ss14://fast", "2026-10-09T12:01:00Z", 3, 20),
    ], "ping");

    expect(result.map((item) => item.address)).toEqual(["ss14://fast", "ss14://slow", "ss14://unknown"]);
  });

  it("orders known player counts descending and keeps unknown values last", () => {
    const result = sortRecentConnections([
      recent("ss14://unknown", "2026-10-09T12:02:00Z", null, 20),
      recent("ss14://small", "2026-10-09T12:01:00Z", 4, 80),
      recent("ss14://large", "2026-10-09T12:00:00Z", 18, 50),
    ], "players");

    expect(result.map((item) => item.address)).toEqual(["ss14://large", "ss14://small", "ss14://unknown"]);
  });

  it("preserves newest-first order for recent sorting", () => {
    const result = sortRecentConnections([
      recent("ss14://old", "2026-10-09T11:00:00Z", 1, 10),
      recent("ss14://new", "2026-10-09T12:00:00Z", 1, 10),
    ], "recent");

    expect(result.map((item) => item.address)).toEqual(["ss14://new", "ss14://old"]);
  });
});
