import type { Favorite } from "../contracts/launcher";
import { sanitizeServerAddress } from "./ui-helpers";

export const homeBlocks = {
  lastServer: "Последний сервер", favorites: "Избранные серверы", week: "Моя неделя",
  recent: "Недавние подключения", quickActions: "Быстрые действия", profiles: "Профили запуска",
} as const;
export type HomeBlock = keyof typeof homeBlocks;
export type HomeLayout = { version: 1; order: HomeBlock[]; hidden: HomeBlock[]; pinned: string[] };
export const homeStorageKey = (accountId: string) => `mados.home.v1.${accountId}`;
export const defaultHomeLayout = (): HomeLayout => ({ version: 1, order: Object.keys(homeBlocks) as HomeBlock[], hidden: [], pinned: [] });
const isBlock = (value: unknown): value is HomeBlock => typeof value === "string" && Object.hasOwn(homeBlocks, value);
export function normalizeHomeLayout(value: unknown): HomeLayout {
  const defaults = defaultHomeLayout();
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return defaults;
  const stored = value as Partial<HomeLayout>;
  const order = Array.isArray(stored.order) ? stored.order.filter(isBlock) : [];
  return { version: 1, order: [...new Set([...order, ...defaults.order])],
    hidden: Array.isArray(stored.hidden) ? [...new Set(stored.hidden.filter(isBlock))] : [],
    pinned: Array.isArray(stored.pinned) ? [...new Set(stored.pinned.filter((address): address is string => typeof address === "string").map(sanitizeServerAddress).filter((address): address is string => Boolean(address)))].slice(0, 4) : [],
  };
}
export function moveHomeBlock(order: HomeBlock[], source: HomeBlock, target: HomeBlock): HomeBlock[] {
  const from = order.indexOf(source), to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order]; next.splice(from, 1); next.splice(to, 0, source); return next;
}
export function orderHomeFavorites(favorites: Favorite[], pinned: string[]): Favorite[] {
  const rank = (favorite: Favorite) => { const index = pinned.indexOf(sanitizeServerAddress(favorite.address) ?? ""); return index < 0 ? pinned.length : index; };
  return [...favorites].sort((a, b) => rank(a) - rank(b));
}
export type CompletedSession = { id: string; accountId: string; address: string; name: string | null; startedAt: string; elapsedSeconds: number };
export function parseCompletedSession(data: unknown, accountId: string): CompletedSession | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  if (value.active !== false || value.accountId !== accountId || typeof value.address !== "string"
    || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))
    || typeof value.elapsedSeconds !== "number" || !Number.isFinite(value.elapsedSeconds) || value.elapsedSeconds < 0) return null;
  const address = sanitizeServerAddress(value.address);
  if (!address) return null;
  return { id: `${accountId}:${address}:${value.startedAt}`, accountId, address,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : null,
    startedAt: value.startedAt, elapsedSeconds: value.elapsedSeconds };
}
