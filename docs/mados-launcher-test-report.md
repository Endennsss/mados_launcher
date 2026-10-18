# Mados Launcher — отчёт проверки

Дата проверки: 2026-10-09.

## Исправление кодировки и данных сервера — 2026-10-18

- Воспроизведена порча UTF-8 в стандартном вводе Windows worker без консоли. `Program` теперь задаёт UTF-8 для обоих потоков до первого IPC-сообщения.
- Общий разбор статуса читает строковые `map` и `preset` из `/status` и hub `statusData`; резервный источник — теги `map:`/`mode:`. Неизвестные форматы дополнительных полей не ломают весь каталог, `rp:` не подменяет игровой режим.
- Реальный `ss14s://server.ss14.org/perseus` через worker вернул русское название, карту `Marathon` и режим `Рассказчик: Безумный`. Это текущие данные сервера, а не постоянные значения. Источник: [публичный status](https://server.ss14.org/perseus/status). Поля являются расширениями контента, а не обязательной частью [HTTP API движка](https://docs.spacestation14.com/en/robust-toolbox/server-http-api.html).
- Описание читается напрямую с сервера, затем через hub при ошибке. Для hub проверяются обе формы завершающего `/` при 404. Доступный `/status` сохраняется, даже если оба источника описания не работают.
- Полученное от сервера имя обновляет только имя недавнего подключения текущего аккаунта. Время последнего входа, исторический ping/онлайн и записи других аккаунтов не меняются. При недоступном сервере старое имя сохраняется до успешного обновления.
- `dotnet build SS14.Launcher.sln --configuration Debug --no-restore` — успешно; `dotnet test SS14.Launcher.sln --configuration Debug --no-build --no-restore` — 105/105.
- `npm run typecheck` и `npm test -- --run` в `Mados.Launcher` — успешно, 176/176.
- `node tools/smoke-worker-unicode.mjs <путь-к-Mados.Worker.exe>` проверяет настоящий IPC, подключение к локальному HTTP fixture, сохранение/перезапуск SQLite, карту/режим, ошибки описания и восстановление имени. `--live` дополнительно проверяет публичный «Персей» без запуска игры. Проверка включена в Windows CI.
- Debug win-x64 собран в `artifacts/mados-debug-unicode-metadata/win-unpacked`. Проверка установленного в пакет worker с `--live` прошла; приложение запускается с одним worker и штатно закрывается с кодом 0, оставшихся процессов — 0. Каталог получил 186 серверов: первые данные за 790 мс, полное обновление за 5374 мс в этой проверке.
- Полноценный вход в игровой раунд и отображение в установленном Discord в этой проверке не выполнялись; проверены ответы реального worker и существующие lifecycle-тесты Presence.

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

