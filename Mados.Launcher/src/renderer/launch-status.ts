import type { ConnectionProgress, WorkerEvent } from "../contracts/launcher";
import { sanitizeServerAddress } from "./ui-helpers";

export type LaunchActivity = ConnectionProgress & {
  name: string | null;
  address: string | null;
  contentBundle: boolean;
  startedAt: number | null;
};

const empty: LaunchActivity = { status: "Connecting", name: null, address: null, contentBundle: false, startedAt: null };
export const launchFailed = (status: string) => ["ConnectionFailed", "UpdateError", "NotAContentBundle", "Error"].includes(status);

export function reduceLaunchEvent(current: LaunchActivity | null, event: WorkerEvent, now = Date.now()): LaunchActivity | null {
  const data = event.data as Partial<LaunchActivity> & { path?: string; message?: string };
  if (event.event === "connection.started") return {
    ...empty, name: data.name || data.path || null, address: sanitizeServerAddress(data.address) || null,
    contentBundle: data.contentBundle === true, reason: null,
  };
  if (event.event === "connection.progress" || event.event === "connection.completed") {
    const status = data.status ?? "Connecting";
    if (status === "ClientExited" || status === "None") return null;
    return { ...empty, ...current, ...data, status,
      progress: undefined, privacyPolicy: data.privacyPolicy ?? null,
      startedAt: status === "ClientRunning" ? current?.startedAt ?? now : current?.startedAt ?? null };
  }
  if (event.event === "connection.failed") return { ...empty, ...current, status: data.status ?? "ConnectionFailed", reason: data.message ?? "Не удалось подключиться к серверу.", progress: undefined };
  if (event.event === "update.progress") {
    if (current?.status === "ClientRunning" || current?.status === "AwaitingPrivacyPolicyAcceptance") return current;
    return { ...empty, ...current, status: data.status ?? "Updating", progress: data.progress };
  }
  if (event.event === "update.completed" && current?.status !== "ClientRunning") {
    if (data.status === "Error") return { ...empty, ...current, status: "UpdateError", reason: "Не удалось обновить игровые файлы.", progress: undefined };
    return current ? { ...current, status: "StartingClient", progress: undefined } : null;
  }
  return current;
}

export function launchPercent(progress: ConnectionProgress["progress"]): number | null {
  if (!progress || typeof progress !== "object") return null;
  const { downloaded, total } = progress;
  if (downloaded == null || total == null || !Number.isFinite(downloaded) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(downloaded / total * 100)));
}

export function launchLabel(status: string): string {
  const labels: Record<string, string> = {
    Connecting: "Проверяем подключение", Updating: "Подготавливаем игровые файлы",
    CheckingClientUpdate: "Проверяем версию игры", CheckingEngineModules: "Проверяем компоненты",
    DownloadingEngineVersion: "Скачиваем движок", DownloadingEngineModules: "Скачиваем компоненты",
    FetchingClientManifest: "Получаем список файлов", DownloadingClientUpdate: "Скачиваем обновление игры",
    Verifying: "Проверяем файлы", CommittingDownload: "Сохраняем обновление", LoadingIntoDb: "Подготавливаем контент",
    CullingEngine: "Обновляем движок", CullingContent: "Обновляем контент", LoadingContentBundle: "Открываем контент-бандл",
    Ready: "Файлы готовы", StartingClient: "Запускаем игру", ClientRunning: "Сейчас играете",
    AwaitingPrivacyPolicyAcceptance: "Нужно ваше подтверждение", Cancelled: "Подключение отменено",
    ConnectionFailed: "Не удалось подключиться", UpdateError: "Не удалось обновить игру", Error: "Не удалось обновить игру",
    NotAContentBundle: "Не удалось открыть контент-бандл",
  };
  return labels[status] ?? "Подготавливаем запуск";
}

export function formatSessionTime(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days} д ${hours % 24} ч ${minutes % 60} мин`;
  if (hours > 0) return `${hours} ч ${minutes % 60} мин`;
  return `${minutes} мин`;
}
