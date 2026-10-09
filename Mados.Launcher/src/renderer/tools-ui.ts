import type { CdnBuildVariant, LocalServerConfig, LocalServerStatus } from "../contracts/launcher";

export const localStatusLabels: Record<LocalServerStatus, string> = {
  idle: "Не запущен", ready: "Готов к запуску", stopped: "Остановлен", starting: "Запускается",
  running: "Работает", stopping: "Останавливается", downloading: "Скачивается", extracting: "Распаковывается", error: "Ошибка",
};

export function isLocalProcessActive(status: LocalServerStatus | undefined): boolean {
  return status === "running" || status === "starting" || status === "stopping";
}

export function buildVariantLabel(build: CdnBuildVariant): string {
  const platforms: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };
  return `${platforms[build.platform] ?? build.platform} · ${build.architecture}`;
}

export function formatBuildSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "Размер не указан";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} ГБ` : `${Math.round(bytes / 1024 ** 2)} МБ`;
}

export function configChanges(base: LocalServerConfig, draft: LocalServerConfig, mode: "fields" | "raw"): string[] {
  if (mode === "raw") return base.rawToml === draft.rawToml ? [] : ["Изменён текст server_config.toml"];
  const fields: Array<[keyof LocalServerConfig, string]> = [["name", "Название"], ["hostname", "Hostname"], ["port", "Порт"], ["maxPlayers", "Лимит игроков"], ["authMode", "Авторизация"]];
  return fields.filter(([key]) => base[key] !== draft[key]).map(([key, label]) => `${label}: ${base[key] ?? "не задано"} → ${draft[key] ?? "не задано"}`);
}

export function importStageLabel(stage: string): string {
  return ({ inspecting: "Проверяем сборку", downloading: "Скачиваем архив", extracting: "Распаковываем файлы", validating: "Проверяем сервер", completed: "Сборка установлена", cancelled: "Установка отменена", failed: "Установка не завершена" } as Record<string, string>)[stage] ?? "Подготавливаем сборку";
}
