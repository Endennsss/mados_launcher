# Mados Launcher — отчёт проверки

Дата проверки: 2026-10-02.

## Пройдено

- `dotnet build SS14.Launcher.sln --configuration Debug` — успешно, ошибок нет.
- `dotnet test SS14.Launcher.sln --configuration Debug --no-restore` — 14/14 тестов.
- `npm run typecheck` — успешно.
- `npm run build` — успешно, renderer собирается с относительными `file://` asset-ссылками.
- `npm test` — 4/4 contract-теста.
- `npm run lint` — успешно.
- `npm run prepare-worker` — успешно для `win-x64`, `win-arm64`, `linux-x64`, `linux-arm64`, `osx-x64`, `osx-arm64`; publish self-contained.
- `electron-builder --win --x64` — успешно: NSIS и ZIP, локально unsigned.
- Debug playtime package `Mados.Launcher.Debug.Playtime.Windows.x64.zip` — собран для Windows x64, локально unsigned.
- GitHub Releases news source — worker merges releases from `Endennsss/mados_launcher` with the official RSS feed and keeps source/date/summary in the response.

## Время игры

- `PlaytimeStoreTests` проверяют схему SQLite, группировку, аккаунты, периоды, heartbeat-восстановление, очистку только текущего аккаунта и реальный переход `ClientRunning` → `ClientExited`.
- Worker IPC smoke получил `app.ready`, реальный `playtime.getSummary` с пустой статистикой и успешный `app.shutdown`; отдельный `playtime.db` создан.
- В packed Electron smoke вкладка поставляется вместе с актуальным C# worker; запуск и штатное закрытие прошли с `worker_after=0`.
- `ServerPingProbeTests` проверяют, что ping запрашивает `/status` конкретного сервера и возвращает пустое значение при недоступности.

## Runtime smoke

- packed Electron запускается с ровно одним `Mados.Worker` и корректно закрывает worker;
- JSON-RPC отвечает на `app.getVersion`, `app.getState`, `app.openDeepLink`, `app.shutdown`;
- `app.ready`, `deepLink.received`, connection/update events проходят через stdio;
- SQLite migration создаёт marker/backup в изолированном каталоге и сохраняет старые cache roots;
- legacy named-pipe bridge принимает URI Loader и hex-команды `C`/`R`;
- renderer visual smoke снят для Home, Servers, News и Settings.

## Известные условия

- macOS/Linux native launch и подпись нельзя подтвердить на Windows host; для них в CI нужно выполнить команды RID matrix из `Mados.Launcher/README.md`.
- Локальный Windows artifact unsigned, поскольку signing secrets не заданы. CI signing не отключён.
- В исходном dependency graph остаются `NU1903` предупреждения SQLite/Tmds.DBus; это отдельная задача обновления зависимостей, не ошибка миграции.
