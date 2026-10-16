# Mados personal toolkit implementation plan

> Execute inline with executing-plans and TDD, then one fresh read-only review. Preserve the existing dirty feature checkout. No commit, push or release.

**Goal:** Deliver all five approved additions and a Windows x64 Debug EXE.
**Spec:** The five in-chat proposals approved on 2026-10-17: verified cache relocation; selective personal backup; local replay library; minimize/return on actual client lifecycle; explicit one-server slot watch.
**Architecture:** Worker owns cache files, replay metadata and personal data. Native main dialogs grant file/directory access; renderer uses typed allowlisted commands and opaque preview IDs. Window lifecycle and safe archive file export/import stay in main. Existing launch/notification/UI state paths are reused.
**Stack:** Existing C#/SQLite, Electron/React/TypeScript, Lucide; no new dependencies.

## Constraints
- Cache transfer is idle-only, cancellable until committing the location, verifies SHA256 and keeps originals until successful restart. Switch migration cache pointers atomically; cleanup only verified unchanged originals, never arbitrary folders. Failed copy leaves source usable. A restart applies new paths.
- Personal backup includes favorites, profiles, notes and explicit appearance/home-layout fields; never login databases, passwords, tokens or arbitrary localStorage. Current-account export/import; selected sections merge by safe server address. Preview binds to active account and expires. Keep a recovery copy before applying.
- Replay library indexes user-selected ZIP files; no extraction/copy/deletion of originals. Read bounded metadata only; retain names, notes and watched flags per account. Launch through content.openBundle and validate the selected ZIP still exists. Public replay downloads/recording are outside scope.
- Window options default off; minimize only on ClientRunning, restore only after a session actually ran. No game-window focus manipulation.
- Watch is opt-in for one server, 30-second checks, maximum 30 minutes, cancellable, stopped on account change/connect/shutdown. It uses online/optional advertised limit, does not reserve a slot or auto-connect. Notify once through existing in-app journal/toast.
- Theme tokens, readable real states, keyboard controls, short one-shot icon motion, app/OS reduced motion. No mock production data.

## Tasks
- [x] 1. Cache transfer service + tests; native folder grant, worker exclusion, progress/cancel/restart UI in Storage.
- [x] 2. Versioned personal archive schema + tests; worker snapshot/selective merge, native save/open, appearance whitelist, preview/recovery UI.
- [x] 3. Replay library SQLite + bounded ZIP validation/tests; native picker/drop, searchable cards/editor, watched flag and real launch in Tools.
- [x] 4. Persist window options + lifecycle tests; main minimize/restore and Settings/search integration.
- [x] 5. Slot watch service + fake-clock/network tests; account/lifecycle cancellation, notification kind, card/detail action and status UI.
- [x] 6. Full tests/typecheck, final review/fixes, real worker IPC smoke and Electron visual checks; Debug publish/package/native startup/shutdown; EXE/report.

## Review focus
- Transfer cancel/crash/disk-full/symlink/nested destination must preserve source and active cache pointer; running clients block mutation.
- Personal restore rejects unexpected fields/oversize/malformed data and stale account previews; partial changes are recoverable and never reported as complete.
- Replay ZIP path/metadata changes and absent files must fail clearly; no archive path can escape through extraction because none occurs.
- Stale watch HTTP responses after cancellation/account change cannot notify; missing advertised limit is unknown, not a free slot.
- StrictMode/navigation cannot trigger duplicate operations; async results are account-bound; every mutation has real busy/error/success.

## Ledger
- Baseline: prior Debug passed 159 TS + 89 C# tests. Branch features/home-personalization contains preceding approved uncommitted work.
- Ruling: user's explicit instruction executes the approved five-feature design; do not introduce repeated planning approvals. Work sequentially inline; final review only.
- Ruling: verified cache originals are cleaned after restart validates new storage, not before the next startup; safety against crashes takes priority over immediate reclamation.

- Core/UI delivered: cache transfer with pause/checkpoint, SHA256/cancel/restart; account-bound personal archive/restore; indexed replay library; client lifecycle window options; bounded explicit slot watch.
- Final read-only review completed. Fixed all four important findings: await favorites commit (and restore cache on failure), normalize equivalent addresses, enforce matching 4 MiB read/write budget, retain old copies without permanently blocking future moves after deferred cleanup.
- Integration caught and fixed override-asset download transaction blocking checkpoint; maintenance now pauses/cancels it before the copy. Real worker smoke validates transfer and restart with this enabled.
- Integration caught shared ZIP drag/drop routing: library drops add the entry and clear the overlay without auto-launch.
- Full tests: 171 TS + 101 C# passing. UI Electron smoke: themes, 800x600, app/OS reduced motion, preview/confirm, editor and notifications. No user data in fixtures.
- Final package: artifacts/mados-debug-personal-toolkit/win-unpacked/Mados Launcher.exe. Bundled real worker smoke passed; native startup/close exit 0, one worker, zero orphans. Worker and Loader hashes match win-x64 Debug DLLs. Build verification JSON includes EXE/asar SHA256. No commit or push.
