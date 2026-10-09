import type { Server, ServerDetails } from "../contracts/launcher";

export function sanitizeServerAddress(address: string | null | undefined): string {
  if (!address?.trim()) return "";
  try {
    const parsed = new URL(address.trim());
    if (parsed.protocol !== "ss14:" && parsed.protocol !== "ss14s:") return "";
    parsed.username = "";
    parsed.password = "";
    if ((parsed.protocol === "ss14:" && parsed.port === "1212") || (parsed.protocol === "ss14s:" && parsed.port === "443")) parsed.port = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function mergeServerDetails(server: Server, details: ServerDetails & { name?: string | null }): Server {
  return {
    ...server,
    ...(details.name !== undefined && details.name !== null ? { name: details.name } : {}),
    ...(details.status !== undefined ? { status: details.status } : {}),
    ...(details.playerCount !== undefined && details.playerCount !== null ? { playerCount: details.playerCount } : {}),
    ...(details.softMaxPlayerCount !== undefined && details.softMaxPlayerCount !== null ? { softMaxPlayerCount: details.softMaxPlayerCount } : {}),
    ...(details.pingMs !== undefined ? { pingMs: details.pingMs } : {}),
    ...(details.map !== undefined ? { map: details.map } : {}),
    ...(details.mode !== undefined ? { mode: details.mode } : {}),
  };
}
