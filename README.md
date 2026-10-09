# Mados Launcher

Mados Launcher — Electron + React + TypeScript интерфейс для Space Station 14 с сохранённым C#-ядром. Worker отвечает за авторизацию, аккаунты, список серверов, избранное, подключения, обновления, deep links, Loader-команды, новости и локальную статистику времени игры.

## Быстрый старт

```powershell
cd Mados.Launcher
npm ci
npm run typecheck
npm test
npm run build
npm start
```

Для разработки с Vite и Electron используйте `npm run dev`. Worker берётся из `Mados.Worker/bin/Debug/net10.0`; для другого пути задайте `MADOS_WORKER_PATH`.

## Сборка

```powershell
cd Mados.Launcher
npm run prepare-worker
npm run dist
```

Поддерживаются Windows x64/ARM64, macOS x64/ARM64 и Linux x64/ARM64. Локальные сборки unsigned. CI проверяет .NET, TypeScript, Vitest и собирает Windows Debug artifact; workflow Pages публикует содержимое `site/`.

## Документация проекта

- [Инвентаризация функций и архитектура](docs/mados-launcher-inventory.md)
- [Отчёт тестов](docs/mados-launcher-test-report.md)
- [Руководство по стилю интерфейса](docs/INTERFACE_STYLE_GUIDE.md)
- [Правила PR и разработки](CONTRIBUTING.md)
- [Контракт IPC](Mados.Launcher/src/contracts/ipc.schema.json)
- [Сайт лаунчера](site/index.html)

Новости в приложении объединяют официальный RSS Space Station 14 и опубликованные releases из [репозитория Mados Launcher](https://github.com/Endennsss/mados_launcher). История времени игры хранится локально в `playtime.db` отдельно для каждого аккаунта.

## Bootstrap-установщик

Каталог `Mados.Installer` содержит отдельный установщик в стиле Mados Launcher. Он не вшивает приложение в себя: при запуске смотрит последний стабильный GitHub Release, скачивает `Mados.Launcher.Windows.x64.zip`, безопасно распаковывает его в выбранное место и запускает лаунчер. Инструкции локальной сборки находятся в [Mados.Installer/README.md](Mados.Installer/README.md).

## Переменные разработки

- `SS14_LAUNCHER_APPDATA_NAME=launcherTest` — изолирует каталоги данных во время разработки.
- `SS14_LAUNCHER_OVERRIDE_AUTH_URL=https://.../` — заменяет auth API для локального тестового сервера.
- `MADOS_WORKER_PATH` — путь к worker executable или DLL.
- `MADOS_WORKER_RID` — RID для подготовки self-contained worker, например `win-arm64`.
- `MADOS_WORKER_CONFIGURATION` — конфигурация publish, обычно `Debug` или `Release`.
