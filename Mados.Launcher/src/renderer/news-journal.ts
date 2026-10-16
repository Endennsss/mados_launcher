import type { NewsItem, ShellUpdateState } from "../contracts/launcher";

export function isMadosRelease(item: NewsItem): boolean {
  try {
    const url = new URL(item.link);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password
      && url.pathname.toLowerCase().startsWith("/endennsss/mados_launcher/releases/tag/");
  } catch { return false; }
}
export function releaseRelation(item: NewsItem, update: ShellUpdateState): "installed" | "available" | null {
  if (!isMadosRelease(item) || item.prerelease || !item.version) return null;
  const version = item.version.replace(/^v/i, "");
  if (version === update.currentVersion.replace(/^v/i, "")) return "installed";
  return ["available", "downloading", "downloaded"].includes(update.status) && version === update.version?.replace(/^v/i, "") ? "available" : null;
}
export const newsReadKey = (accountId: string) => `mados.newsRead.${accountId}`;
export function readNewsHistory(accountId: string): string[] {
  const stored: unknown = JSON.parse(localStorage.getItem(newsReadKey(accountId)) ?? "[]");
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string" && id.length <= 2048).slice(-200) : [];
}
export function newsDate(value?: string | null): string {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) : "Дата не указана";
}
