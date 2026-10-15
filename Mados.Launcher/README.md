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

## Discord Rich Presence

Rich Presence работает через Discord IPC в Electron main process и использует приложение `1555589477492199434`. Renderer не получает Discord API. В настройках можно отключить Presence или скрыть ник; при закрытом Discord лаунчер продолжает работать без ошибки. Для большой картинки в Discord Developer Portal загрузите asset с ключом `mados-cat` — без него текстовая активность всё равно отображается.

Во время выбора сервера показывается состояние лаунчера. После `ClientRunning` worker каждые 30 секунд обновляет отдельный status/ping конкретного сервера и передаёт main только структурированное событие `presence.updated`. Карта и режим берутся исключительно из тегов `map:` и `mode:`; неизвестные значения отображаются как `Не указано`. Deep link адрес перед отправкой очищается от query, fragment и userinfo.

Для cross-build в CI можно явно указать RID (`$env:MADOS_WORKER_RID = "win-arm64"`, затем `npm run prepare-worker`) и передать electron-builder нужную архитектуру (`electron-builder --win --arm64`, `--mac --arm64`, `--linux --arm64`).

## Инструменты и локальный сервер

Вкладка «Инструменты» принимает публичную HTTPS-страницу Robust.Cdn или ZIP,
выбирает сборку для текущей ОС/архитектуры и устанавливает её в отдельный
каталог `launcher-tools.db` и `local-servers`. Renderer не получает доступ к
процессам и файлам: worker сам проверяет ZIP, сохраняет конфигурацию через
Tomlyn, запускает только один сервер на `127.0.0.1`, проверяет `/status`, ведёт
live-логи и останавливает дерево процессов при закрытии лаунчера.

Параметры формы сохраняются в `server_config.toml`; расширенный TOML-режим
делает атомарную запись после валидации. Перед ручным обновлением создаётся
backup с конфигурацией и `data`, доступен откат. Секретные значения остаются в
worker и заменяются на безопасные маркеры в renderer и логах.

Для локальной проверки worker можно запустить из каталога `Mados.Launcher`:

```powershell
node tools/smoke-local-server.mjs
```

Debug-пакет Windows x64 собирается так:

```powershell
$env:MADOS_WORKER_CONFIGURATION = "Debug"
$env:MADOS_WORKER_RID = "win-x64"
npm run build
npm run prepare-worker
npx electron-builder --dir --config.directories.output=../artifacts/mados-tools-debug
```

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

## Обновления Mados

Electron проверяет стабильные GitHub Releases `Endennsss/mados_launcher` через
10 секунд после запуска и затем раз в час. Обнаружение версии только уведомляет:
скачивание начинается по кнопке «Скачать», установка — по «Перезапустить и обновить».
Обычное закрытие приложения не устанавливает обновление. Во время игры или
подключения перезапуск для обновления заблокирован; локальный сервер перед
перезапуском останавливается через существующее подтверждение и worker.

Состояние доступно в «Настройки → Обновления» и сохраняется при переходах между
экранами. Переустановка не затрагивает пользовательский каталог данных. Проверка
официального SS14 Launcher больше не определяет актуальность Mados; игровые
манифесты, updater контента и предупреждения совместимости продолжают работать.

Windows получает NSIS-установщик `Mados.Launcher.Windows.{x64|arm64}.exe` непосредственно
из GitHub API, проверяет хеш и обновляет текущую папку, включая установку из ZIP.
`latest.yml` для этого пути не требуется. Используется SHA256 digest GitHub;
для новых релизов `tools/release-checksums.mjs` создаёт соседний `.exe.sha512`,
который включает проверяемый кеш electron-updater между перезапусками.
Перед тегом обновите `package.json`: версия должна совпадать с `vX.Y.Z`, иначе CI
остановит выпуск. Загрузите NSIS EXE и SHA512 вместе с ZIP, а затем публикуйте релиз.

На macOS и Linux AppImage сохранён стандартный electron-updater. Linux ZIP не
поддерживает автоматическую установку и показывает ссылку на GitHub. Проверки
разработки без packaging не обращаются к сервису обновлений. `mados-update.yml`
обеспечивает конфигурацию кеша для ZIP/Debug-пакетов без `app-update.yml`.

## Публикация релиза

Релиз создаётся тегом `v<version>` после обновления версий в `package.json`
обоих приложений и `Launcher.props`. Workflow собирает шесть архитектурных
пакетов и Windows bootstrap-установщик. Перед публикацией
`tools/assemble-release.mjs` проверяет полный набор, контрольные суммы и
объединяет `latest*.yml` разных архитектур; файлы загружаются в черновик,
который становится публичным только после успешной загрузки всех файлов.
Описание релиза хранится в `docs/releases/v<version>.md` в корне репозитория.
Уже опубликованный релиз workflow не перезаписывает.

## Данные и откат

Первый запуск worker создаёт `Mados Launcher/launcher/migration-v1.json`. Он создаёт резервную копию SQLite `settings.db` в `Mados Launcher/launcher/backups/<UTC>-<version>`, переносит настройки/аккаунты/избранное атомарно и оставляет многогигабайтные engine/content каталоги на старых путях. Для отката закройте Mados Launcher, скопируйте нужный `settings.db` из backup обратно в `Mados Launcher/launcher/settings.db`, удалите `migration-v1.json` и запустите снова. Старый каталог `Space Station 14/launcher` не удаляется.

## Проверки smoke

Главная показывает последнее успешное подключение из истории, отдельно запрашивает
текущий статус сервера и время игры текущего аккаунта. Сохранённый ранее выбранный
сервер используется как подписанный fallback, если истории ещё нет. Описание
открывается в немодальной боковой панели; каталог сохраняет прокрутку. Панель
запуска снизу следует событиям worker, сохраняется между загрузкой и запуском,
показывает ошибки и запрос согласия с политикой сервера. Счётчик начинается только
при `ClientRunning`, без учёта скачивания; ZIP и реплеи не создают статистику.

Карточка последнего сервера, боковое описание и панель запуска используют общие
цветовые переменные лаунчера (`hero`, `card`, `modal`, `accent`), включая все темы.
Движения иконок проигрываются один раз при наведении, открытии или смене стадии.
Повторяется только индикатор реальной загрузки; изменения процентов и таймера
не перезапускают анимацию стадии. Обе настройки reduced motion отключают движение.

Все разделы используют общий слой `interface-system.css`: одинаковые поверхности,
заголовки, поля, кнопки, меню и движения иконок. `SelectField`, `ConfirmProvider` и
`TooltipLayer` заменяют нативные выпадающие списки, подтверждения renderer и подсказки.
Клавиатурный фокус возвращается к исходному элементу после закрытия меню или диалога.
Переход значка сервера из карточки в описание и панель запуска не меняет расположение
каталога и отключается вместе с reduced motion. Правила расширения интерфейса
описаны в `../docs/INTERFACE_STYLE_GUIDE.md`.

Каталог показывает данные по мере получения ответов hub; индивидуальный HTTP ping
дополняется пакетами в фоне (не больше 12 запросов одновременно). Повторное открытие
использует кеш worker в течение 30 секунд. Ручное обновление обходит кеш, а повторные
запросы во время активного обновления присоединяются к нему. Постоянного фонового
опроса нет. Мониторинг избранного записывает результаты только ручного обновления.

Карточки серверов расположены сразу под поиском и компактной строкой дополнительных
действий. Мониторинг избранного, профили и подключение по адресу раскрываются по
одному, сохраняя введённые данные. Команда мониторинга в Ctrl+K открывает панель без
лишнего обновления каталога. В инструментах главная кнопка соответствует этапу
импорта или состоянию процесса; обслуживание сервера находится в меню «Ещё».
Меню поддерживает клавиатуру и уступает фокус командной палитре. Проверяйте также
узкое окно, смену состояния запуска и отключение движения.

Проверка отзывчивости IPC, появления каталога, кеша и закрытия во время обновления:

```powershell
node tools/smoke-server-catalog.mjs staging/worker/win-x64/Mados.Worker.exe
```

Проверка использует отдельный временный каталог данных и реальный публичный hub;
время первого ответа зависит от сети. При сбое всех hub кеш остаётся видимым
с сообщением об устаревших данных.

Проверены: запуск worker с реальными аккаунтами и избранным, `app.getVersion`, `app.getState`, `ss14://`/`ss14s://`, Loader named-pipe команда, выход worker, Electron packaged process с bundled worker, миграция SQLite, список hub-серверов, фильтры/поиск, избранное, direct connect, drag-and-drop ZIP, новости, настройки, reduced motion, expired account state, update/error banners и single-instance forwarding.

Полная матрица источников данных и ручных сценариев находится в `../docs/mados-launcher-inventory.md`, схема — в `src/contracts/ipc.schema.json`.

Скриншоты renderer: `../docs/screenshots/mados-home.png`, `mados-servers.png`, `mados-news.png`, `mados-settings.png`. Подробный test report: `../docs/mados-launcher-test-report.md`.
