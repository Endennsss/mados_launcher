# Mados Launcher — отчёт проверки

Дата проверки: 2026-10-09.

## Пройдено

- `dotnet build SS14.Launcher.sln --configuration Debug` — успешно, ошибок нет.
- `dotnet test SS14.Launcher.Tests/SS14.Launcher.Tests.csproj --configuration Debug --no-restore` — 56/56 тестов.
- `npm run typecheck` — успешно.
- `npm run build` — успешно, renderer собирается с относительными `file://` asset-ссылками.
- `npm test -- --run` — 34/34 теста в 9 файлах.
- `npm run lint` — успешно.
- `npm run prepare-worker` — успешно для `win-x64` в текущей Debug-проверке; publish self-contained.
- `electron-builder --win dir` — успешно: [локальный Debug unpacked Mados Launcher.exe](../artifacts/mados-debug-insights/win-unpacked/Mados%20Launcher.exe), unsigned.
- Current Release package: [Mados Launcher v0.40.3 on GitHub](https://github.com/Endennsss/mados_launcher/releases/tag/v0.40.3), with Windows x64 installer and portable ZIP.
- GitHub Releases news source — worker merges releases from `Endennsss/mados_launcher` with the official RSS feed and keeps source/date/summary in the response.

## Время игры

- `PlaytimeStoreTests` проверяют схему SQLite, группировку, аккаунты, периоды, heartbeat-восстановление, очистку только текущего аккаунта и реальный переход `ClientRunning` → `ClientExited`.
- Worker IPC smoke получил `app.ready`, реальный `playtime.getSummary` с пустой статистикой и успешный `app.shutdown`; отдельный `playtime.db` создан.
- В packed Electron smoke вкладка поставляется вместе с актуальным C# worker; запуск и штатное закрытие прошли с `worker_after=0`.
- `ServerPingProbeTests` проверяют, что ping запрашивает `/status` конкретного сервера и возвращает пустое значение при недоступности.
- `ServerStatusSnapshotTests` проверяют явные теги `map:`/`mode:` и отсутствие догадок при их отсутствии.
- `PresenceAddressTests` проверяют очистку query, fragment и userinfo до отправки в Electron/Discord.
- `PresenceTrackerTests` проверяют переход `ClientRunning` → `ClientExited`, polling только для живой игры и исключение ZIP/replay.
- `ServerNotesStoreTests` проверяют создание/изменение/удаление заметок, нормализацию адреса и изоляцию аккаунтов.
- `RecentConnectionStoreTests` проверяют успешные подключения, порядок/лимит, неизвестные значения ping/online и изоляцию аккаунтов.
- `discord-presence.test.ts` проверяет форматирование активности, fallback очищенного адреса и скрытие ника.

## Инструменты и локальный сервер

- `LocalServerTests` проверяют отдельную `launcher-tools.db`, TOML-валидацию и
  защиту секретов, импорт CDN/ZIP, выбор OS/архитектуры, сохранение `data`,
  backup/rollback и синхронизацию порта профиля после редактирования.
- Реальный worker smoke проходит импорт ZIP, конфигурацию в двух режимах,
  readiness через `/status`, stdout/stderr, редактирование секретов, graceful
  stop, ручное обновление, сохранение данных, backup/rollback и cleanup при
  `app.shutdown`.
- CDN-запросы в worker используют отдельный клиент без автоматических
  redirect; каждый хост проверяется после DNS-разрешения, чтобы публичная
  ссылка не могла обратиться к loopback/private адресу.
- Debug unpacked package: [Mados Launcher.exe](../artifacts/mados-tools-debug/win-unpacked/Mados%20Launcher.exe). Запуск smoke прошёл, после остановки дерева процессов Mados процессов не осталось.

## Runtime smoke

- packed Electron запускается с ровно одним `Mados.Worker` и корректно закрывает worker;
- JSON-RPC отвечает на `app.getVersion`, `app.getState`, `app.openDeepLink`, `app.shutdown`;
- Worker smoke получил `presence.updated` при старте, `settings.changed` и очистку Presence при выключении настройки; payload не содержит токенов.
- `app.ready`, `deepLink.received`, connection/update events проходят через stdio;
- SQLite migration создаёт marker/backup в изолированном каталоге и сохраняет старые cache roots;
- legacy named-pipe bridge принимает URI Loader и hex-команды `C`/`R`;
- renderer visual smoke снят для Home, Servers, News и Settings.
- Discord Presence formatting и worker boundary проверены статически; полноценный IPC smoke зависит от наличия локального Discord клиента.
- Последняя проверка renderer: 9 файлов, 34 теста; typecheck и production build проходят.

## Известные условия

- macOS/Linux native launch и подпись нельзя подтвердить на Windows host; для них в CI нужно выполнить команды RID matrix из `Mados.Launcher/README.md`.
- Локальный Windows artifact unsigned, поскольку signing secrets не заданы. CI signing не отключён.
- В исходном dependency graph остаются `NU1903` предупреждения SQLite/Tmds.DBus; это отдельная задача обновления зависимостей, не ошибка миграции.

