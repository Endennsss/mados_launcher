# Connection diagnostics and storage implementation plan

> Implement inline using executing-plans, TDD and one final read-only review. Local work only; no commit or push.

**Goal:** Approved connection diagnostics and disk management, styled in Mados, delivered as Windows x64 Debug EXE.
**Architecture:** Worker owns bounded network probes and managed storage operations. Renderer consumes structured reports and opaque cleanup plans. Existing connection and local-server APIs remain the only launch path.
**Spec:** User approved the preceding in-chat proposal: explain connection failures and actionable recovery; show managed disk usage, select old versions, preview cleanup, protect active files and user data.
**Tech:** Existing C#, SQLite/Dapper, Electron, React/TypeScript, Lucide and theme tokens. No added dependencies.

## Constraints and decisions
- Continue approved dirty feature checkout; preserve all preceding work. No publishing or real-user-data cleanup during tests.
- Diagnosis runs only on request. Probe sanitized SS14 server status/info, local account state, available storage and required installed engine archive. Report missing downloads as a normal required download, never as successful file verification. Do not export addresses with credentials/query, tokens, server response bodies, or exception text.
- Storage inventories managed content DB, engines/modules, logs, local-server data/backups. External ZIP/replays remain outside managed storage and are not scanned or removed.
- Content versions share blobs: preview estimates only bytes exclusively reclaimable for the selected versions. Keep newest per fork and active versions. Engine archives referenced by content remain protected. Modules and local-server/user data are read-only in this cleanup UI.
- Preview returns an expiring opaque plan. Execution revalidates selection, version state, file metadata and running clients. No paths/account IDs supplied by renderer. No deletion during launcher-owned connection/update/import/process activity. Content deletion uses a SQLite transaction and retains shared/interrupted-download blobs; compact afterward, report actual measured size change.
- Every filesystem mutation validates managed root containment and rejects symlinks/reparse points. Errors remain visible; partial success is reported honestly.
- Short meaningful motion, all theme tokens, both reduced-motion controls. No fake progress.

## Tasks
1. [x] Worker services and regression tests: bounded diagnostics/sanitization/failures; storage accounting/shared blobs/protected versions/active processes/expired or changed preview/reparse paths/transaction cleanup.
2. [x] IPC and worker integration: diagnostics.run/openLogs, storage.scan, storage.preview, storage.clean; strict parameter validation and lifecycle exclusion; contract tests.
3. [x] UI: DiagnosticsView, StorageView, Tools navigation, launch-error shortcut, readable export/actions, selectable old versions and confirmed preview; async/stale/error/component tests and Mados CSS.
4. [x] Final review/fixes, full tests/typecheck, Electron visual smoke, Debug publish/package/native startup/shutdown and EXE link.

## Review focus
- Deleting shared blobs, latest/active content or files outside managed roots must be impossible through IPC selections.
- Cleanup must not race a new connection/import or use an outdated preview after content/files changed.
- Network diagnosis must not leak credentials or claim all files/authentication were verified when only local state was checked.
- Switching views/accounts/targets must not let old reports or cleanup responses replace current state.
- Errors, empty storage, partial file access, keyboard operation and reduced motion remain readable and usable.

## Ledger
- Baseline: 155 TS and 76 C# tests passed in preceding delivery; extensive uncommitted approved work retained.
- Ruling: implement approved scope directly; repeated permission gates are superseded by the user's execution request and standing autonomy instructions. Plan is a local implementation record.
- Final review found two P2 issues: manifest CDN selection differed from Updater, and error-triggered diagnostics could rerun on navigation. Both fixed with observed red→green regression tests. StrictMode effect replay now also preserves the real diagnostic result.
- Verification: TypeScript typecheck, all 159 Vitest tests, all 89 NUnit tests, Debug worker build and Debug worker/Loader self-contained publish passed. Electron UI smoke passed with all five themes, 800×600 layout, app/OS reduced motion, cleanup confirmation/cancellation and error shortcut; screenshots inspected.
- Real worker IPC smoke used isolated migrated data and a local HTTP fixture: sanitized status/info/HEAD requests, protected newest version, shared-blob accounting, one-use cleanup plan, content/log removal, retained shared blobs and SQLite integrity/FK checks passed. Repeated using the packaged worker EXE.
- Windows Debug package: `artifacts/mados-debug-maintenance/win-unpacked/Mados Launcher.exe`. Native startup found exactly one bundled worker; normal window close exited 0 with zero orphan processes. Bundled worker/Loader DLL hashes match Debug publish outputs.
- Limits: cleanup removes selected old content versions and logs older than seven days. Engines/modules, local-server data/backups, user settings/accounts and external ZIP/replays are not deleted. Diagnostics tests metadata/local state, not full game authentication, signatures or a playable session. Only Windows x64 Debug was packaged for this request; no Git commit/push/release.
- Existing dependency warnings remain: NU1903 for SQLitePCLRaw.lib.e_sqlite3 2.1.4 and Tmds.DBus.Protocol 0.20.0, plus prior nullable/RID/Vite deprecation warnings. Dependency upgrades were outside this change.
