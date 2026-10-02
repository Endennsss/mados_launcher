## Что меняется

<!-- Опишите проблему и итоговое поведение. Не пересказывайте историю переписки. -->

## Проверка

- [ ] `dotnet build SS14.Launcher.sln --configuration Debug`
- [ ] `dotnet test SS14.Launcher.sln --configuration Debug --no-restore`
- [ ] `npm run typecheck`
- [ ] `npm test -- --run`
- [ ] Debug/package smoke, если менялся Electron, worker или упаковка

## Интерфейс

- [ ] Добавлены loading/empty/error/disabled состояния, где они применимы
- [ ] Проверены клавиатура и reduced motion
- [ ] Добавлен screenshot или видео для визуального изменения

## Риски и откат

<!-- Укажите миграции, совместимость, ограничения и способ отката. -->
