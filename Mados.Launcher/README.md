# Mados Launcher

Electron + React + TypeScript UI для существующего SS14 C# ядра. Renderer не получает токены, файловую систему или Node API: он вызывает только allowlist из preload. Worker работает отдельным процессом и общается с main process line-delimited JSON-RPC через stdio.

## Локальный запуск

Из каталога `Mados.Launcher`:

```powershell
npm install
npm run typecheck
npm test
npm run build
npm start
```

`npm start` использует собранный renderer и запускает `Mados.Worker` из `../Mados.Worker/bin/Debug/net10.0`. Для разработки с hot reload используется `npm run dev`. Если worker находится в другом месте, задайте `MADOS_WORKER_PATH`.

## Сборка

```powershell
npm run prepare-worker
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false' # локальный unsigned артефакт
npm run dist
```

`prepare-worker` публикует self-contained worker с RID текущей машины в `staging/worker/<rid>`, поэтому упакованный launcher не требует установленного .NET runtime. CI должен запускать этот шаг на каждом runner для `win-x64`, `win-arm64`, `osx-x64`, `osx-arm64`, `linux-x64` и `linux-arm64`. Доступны NSIS + ZIP для Windows, DMG + ZIP для macOS и AppImage + ZIP для Linux. При отсутствии CI secrets артефакт остаётся unsigned и сборка не блокируется.

Для cross-build в CI можно явно указать RID (`$env:MADOS_WORKER_RID = "win-arm64"`, затем `npm run prepare-worker`) и передать electron-builder нужную архитектуру (`electron-builder --win --arm64`, `--mac --arm64`, `--linux --arm64`).

Матрица релизов выполняет в чистом checkout:

```powershell
# Windows x64 / ARM64
$env:MADOS_WORKER_RID = "win-x64"; npm run prepare-worker; npx electron-builder --win --x64
$env:MADOS_WORKER_RID = "win-arm64"; npm run prepare-worker; npx electron-builder --win --arm64

# macOS x64 / ARM64
$env:MADOS_WORKER_RID = "osx-x64"; npm run prepare-worker; npx electron-builder --mac --x64
$env:MADOS_WORKER_RID = "osx-arm64"; npm run prepare-worker; npx electron-builder --mac --arm64

# Linux x64 / ARM64
$env:MADOS_WORKER_RID = "linux-x64"; npm run prepare-worker; npx electron-builder --linux --x64
$env:MADOS_WORKER_RID = "linux-arm64"; npm run prepare-worker; npx electron-builder --linux --arm64
```

## Данные и откат

Первый запуск worker создаёт `Mados Launcher/launcher/migration-v1.json`. Он создаёт резервную копию SQLite `settings.db` в `Mados Launcher/launcher/backups/<UTC>-<version>`, переносит настройки/аккаунты/избранное атомарно и оставляет многогигабайтные engine/content каталоги на старых путях. Для отката закройте Mados Launcher, скопируйте нужный `settings.db` из backup обратно в `Mados Launcher/launcher/settings.db`, удалите `migration-v1.json` и запустите снова. Старый каталог `Space Station 14/launcher` не удаляется.

## Проверки smoke

Проверены: запуск worker с реальными аккаунтами и избранным, `app.getVersion`, `app.getState`, `ss14://`/`ss14s://`, Loader named-pipe команда, выход worker, Electron packaged process с bundled worker, миграция SQLite, список hub-серверов, фильтры/поиск, избранное, direct connect, drag-and-drop ZIP, новости, настройки, reduced motion, expired account state, update/error banners и single-instance forwarding.

Полная матрица источников данных и ручных сценариев находится в `../docs/mados-launcher-inventory.md`, схема — в `src/contracts/ipc.schema.json`.

Скриншоты renderer: `../docs/screenshots/mados-home.png`, `mados-servers.png`, `mados-news.png`, `mados-settings.png`. Подробный test report: `../docs/mados-launcher-test-report.md`.
