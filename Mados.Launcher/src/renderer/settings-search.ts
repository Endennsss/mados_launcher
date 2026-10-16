import { Download, Languages, Radio, ShieldCheck, Sparkles, TerminalSquare, UserRound } from "lucide-react";

export const settingsSections = [
  { id: "account", label: "Аккаунт", icon: UserRound },
  { id: "appearance", label: "Внешний вид", icon: Sparkles },
  { id: "discord", label: "Discord", icon: Radio },
  { id: "compatibility", label: "Совместимость", icon: ShieldCheck },
  { id: "diagnostics", label: "Диагностика", icon: TerminalSquare },
  { id: "updates", label: "Обновления", icon: Download },
] as const;
export type SettingsSection = typeof settingsSections[number]["id"];

// Both search surfaces and the settings controls share this vocabulary and target IDs.
export const searchableSettings = [
  { id: "account", section: "account", title: "Текущий аккаунт", description: "Активная сессия Mados Launcher", keywords: ["профиль", "account"], icon: UserRound },
  { id: "account-management", section: "account", title: "Управление аккаунтом", description: "Настройки учётной записи на официальном сайте", keywords: ["пароль", "password", "email", "почта", "2fa"], icon: UserRound },
  { id: "theme", section: "appearance", title: "Тема интерфейса", description: "Цветовые темы с предпросмотром", keywords: ["цвет", "красный", "оформление", "theme", "палитра"], icon: Sparkles },
  { id: "motion", section: "appearance", title: "Уменьшить движение", description: "Отключить переходы и анимации интерфейса", keywords: ["анимация", "анимации", "иконки", "motion"], icon: Sparkles },
  { id: "minimize-on-play", section: "appearance", title: "Сворачивать при запуске игры", description: "Только когда игровой клиент действительно запущен", keywords: ["свернуть", "окно", "игра", "minimize"], icon: Sparkles },
  { id: "restore-after-play", section: "appearance", title: "Вернуться в Mados после игры", description: "Восстанавливать окно после завершения игрового клиента", keywords: ["вернуть", "окно", "игра", "restore"], icon: Sparkles },
  { id: "notifications", section: "appearance", title: "Уведомления доступности избранных", description: "Сообщать, когда избранный сервер снова появился онлайн", keywords: ["оповещения", "notification", "тост"], icon: Sparkles },
  { id: "language", section: "appearance", title: "Язык интерфейса", description: "Русский, English или системный язык", keywords: ["language", "перевод", "английский"], icon: Languages },
  { id: "presence", section: "discord", title: "Rich Presence", description: "Показывать состояние лаунчера и игры в Discord", keywords: ["дискорд", "статус", "сервер", "онлайн", "пинг", "ping"], icon: Radio },
  { id: "nickname", section: "discord", title: "Показывать ник в Discord", description: "Ник активного аккаунта в игровом статусе", keywords: ["дискорд", "имя", "nickname", "приватность"], icon: Radio },
  { id: "discord-status", section: "discord", title: "Состояние Discord", description: "Проверить подключение к Discord", keywords: ["дискорд", "не найден", "подключён"], icon: Radio },
  { id: "discord-image", section: "discord", title: "Картинка в Discord", description: "Необязательная иллюстрация для Rich Presence", keywords: ["дискорд", "asset", "mados-cat", "расширенные"], icon: Radio },
  { id: "compatibility", section: "compatibility", title: "Режим совместимости", description: "Использовать безопасные графические параметры", keywords: ["compatibility", "графика", "видеокарта"], icon: ShieldCheck },
  { id: "assets", section: "compatibility", title: "Сезонные ресурсы", description: "Разрешить загрузку официальных override-ассетов", keywords: ["seasonal", "assets", "override"], icon: ShieldCheck },
  { id: "logging", section: "diagnostics", title: "Подробное логирование", description: "Нужно для разбора сложных проблем запуска", keywords: ["логи", "лог", "logs", "verbose", "ошибки"], icon: TerminalSquare },
  { id: "version", section: "diagnostics", title: "Версия", description: "Установленная версия Mados Launcher", keywords: ["version", "сборка"], icon: TerminalSquare },
  { id: "updates", section: "updates", title: "Обновления Mados Launcher", description: "Проверить релиз, скачать и установить обновление", keywords: ["github", "update", "обновить", "загрузка"], icon: Download },
] as const;
export type SettingId = typeof searchableSettings[number]["id"];
export type SettingSearchRequest = { id: SettingId; revision: number };
export const settingById = (id: SettingId) => searchableSettings.find(item => item.id === id)!;
export const normalizeSearch = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/ё/g, "е");
export function searchSettings(query: string) {
  const tokens = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  return searchableSettings.filter(item => {
    const section = settingsSections.find(section => section.id === item.section)!.label;
    const text = normalizeSearch([item.title, item.description, section, ...item.keywords].join(" "));
    return tokens.every(token => text.includes(token));
  });
}
