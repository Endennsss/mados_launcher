import type {
  FavoriteMonitorSample,
  FavoriteMonitorSummary,
  LaunchProfile,
  LauncherNotification,
} from "../contracts/launcher";

export type MonitorSample = FavoriteMonitorSample;
export type { FavoriteMonitorSummary, LaunchProfile, LauncherNotification };

export type NotificationKind = LauncherNotification["kind"];

export function formatDelta(value: number | null, unit = ""): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "—";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value}${unit}`;
}

export function formatDurationSince(iso: string, now = Date.now()): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "только что";
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (seconds < 60) return "только что";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

/** Returns a normalized SVG polyline representation for a compact sparkline. */
export function sparklinePoints(samples: MonitorSample[], width = 120, height = 34): string {
  const values = samples.filter((sample) => sample.pingMs != null && Number.isFinite(sample.pingMs)).map((sample) => sample.pingMs as number);
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

export function notificationUnreadCount(items: LauncherNotification[]): number {
  return items.reduce((count, item) => count + (item.readAt ? 0 : 1), 0);
}

export function notificationTone(kind: NotificationKind): "success" | "info" {
  return kind === "favorite-online" ? "success" : "info";
}
