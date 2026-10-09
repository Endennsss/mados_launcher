import type { RecentConnection } from "../contracts/launcher";

export type { RecentConnection } from "../contracts/launcher";

export type RecentConnectionSort = "recent" | "players" | "ping";

/** Sorts a copy so renderer state remains immutable. Unknown metrics stay last. */
export function sortRecentConnections(items: RecentConnection[], sort: RecentConnectionSort): RecentConnection[] {
  return [...items].sort((left, right) => {
    if (sort === "players") {
      const playerOrder = compareKnownDescending(left.playerCount, right.playerCount);
      if (playerOrder !== 0) return playerOrder;
    } else if (sort === "ping") {
      const pingOrder = compareKnownAscending(left.pingMs, right.pingMs);
      if (pingOrder !== 0) return pingOrder;
    }

    return new Date(right.lastConnectedAt).getTime() - new Date(left.lastConnectedAt).getTime();
  });
}

function compareKnownDescending(left: number | null, right: number | null): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return right - left;
}

function compareKnownAscending(left: number | null, right: number | null): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return left - right;
}
