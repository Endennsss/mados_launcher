# Mados Launcher Installer

Это bootstrap-установщик Mados Launcher. Он не содержит сам лаунчер и C# worker внутри пакета. При запуске он проверяет последний стабильный GitHub Release, скачивает `Mados.Launcher.Windows.x64.zip` по HTTPS, распаковывает сборку в выбранную папку и запускает `Mados Launcher.exe`.

## Локальная проверка

Из каталога `Mados.Installer`:

```powershell
npm install
npm test
npm run typecheck
npm run build
npm run dist:dir
```

Debug unpacked build будет в `../artifacts/mados-installer-debug/win-unpacked`. Проверить состав пакета:

```powershell
node scripts/verify-package.mjs ..\artifacts\mados-installer-debug\win-unpacked
```

Windows portable EXE (он сразу открывает интерфейс установщика, без NSIS-мастера):

```powershell
npm run dist
```

Результат: `../artifacts/mados-installer/Mados.Installer.Windows.x64.exe`. Он не содержит ZIP лаунчера: при запуске получает последний стабильный asset GitHub Releases.

## Источник релиза

Установщик использует публичный API `https://api.github.com/repos/Endennsss/mados_launcher/releases/latest`, пропускает draft/prerelease и принимает только точный asset `Mados.Launcher.Windows.x64.zip`. Авторизация и приватные CDN не поддерживаются.

При обновлении staging-каталог готовится отдельно. Пользовательские каталоги `data`, `launcher` и локальные `.db` сохраняются, а `resources/app.asar` заменяется новой версией. Старый каталог получает timestamped backup.
