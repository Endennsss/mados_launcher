# Current game and Tools journey implementation plan

> Use superpowers:executing-plans inline, with TDD and one final read-only review. No commits or pushes.

**Goal:** Deliver the approved current-game dock and step-based Tools UI, in Mados style, followed by a runnable Windows x64 Debug package.
**Architecture:** Extend existing LaunchDock and ToolsView. Use existing connection/presence/server-info and local-server APIs. Keep worker ownership of processes, files, elapsed-time persistence and account data.
**Tech stack:** React/TypeScript, Lucide, existing theme tokens, Electron and Debug C# worker/Loader.
**Spec:** User-approved preceding in-chat proposal: current session panel with real server/time/map/online, expandable details and connected end-of-session transition; Tools Build → Configure → Run, prominent local-server state, collapsible logs with highlighted errors and pausable auto-scroll.

## Constraints and rulings

- Continue the existing dirty features/home-personalization checkout; prior approved work is required by these changes. Preserve all user changes. No commit, push, release or dependency additions.
- Use real worker responses, never generated metrics/progress. No additional background server polling: fetch once at ClientRunning, support manual refresh, consume existing presence events for matching sessions.
- Discord opt-out must not prevent manual server-info display. Ignore stale requests and snapshots for other addresses/sessions; ZIP/replays have no server metrics.
- Existing tools functionality stays available: import/cancel/update/rollback, config/backup, process actions and per-profile logs.
- Stage navigation preserves drafts. A configuration is not marked saved until the worker confirms; ready/running comes from worker state. Unsaved configuration is clearly called out before starting.
- Theme tokens and Lucide only. Short meaningful one-shot motion, repeating only for real work. OS/app reduced motion disables transforms.
- No new C# contract is required. Final native smoke uses isolated data and the real bundled Debug worker.

## Review focus

- Late server-info/presence cannot overwrite another session; unavailable metrics are unknown.
- Step transitions and profile selection do not silently discard unsaved server config.
- Pending process/import/config work cannot be double-submitted or visually reported as successful early.
- Log pause stops scrolling, not collection; profile switching must not mix logs, and errors remain readable.
- Keyboard focus, hidden panel accessibility, narrow windows and reduced motion remain usable.

### Task 1 — Current session

Files: LaunchDock.tsx, current-game.ts, current-game.test.tsx, App.tsx, session-tools.css.
Interfaces: useCurrentGame(activity) returns matching server details/loading/error/refresh. Existing LaunchActivity remains the lifecycle source; LaunchDock accepts optional onOpenServer.
- [x] Add tests for initial real fetch, matching live updates, stale replies, disabled Presence, bundle exclusion and expanded details.
- [x] Implement current-session metrics/actions and shared dock-to-recap visuals without changing time accounting.
- [x] Verify focused tests.

### Task 2 — Tools journey and logs

Files: ToolsView.tsx, ToolsJourney.tsx, LocalServerLogs.tsx, tools-journey.test.tsx, local-server-logs.test.tsx, session-tools.css.
Interfaces: journey steps are build/config/run; current ToolsView owns selection, configuration and process lifecycle. Logs receive selected profile and real bounded event buffer; local controls filter/pause presentation only.
- [x] Add tests for stage navigation, import-to-config, save-to-run, unsaved-draft safeguards and log pause/filter/profile isolation.
- [x] Implement step navigation and one visible work area, current-server overview and collapsible log viewer.
- [x] Verify existing controls and new behavior.

### Task 3 — Verification and Debug delivery

- [x] Document patterns, final read-only review and fixes.
- [x] Typecheck, full TS and C# tests; Electron UI smoke/screenshots for stages/session/errors/themes/keyboard/reduced motion.
- [x] Build renderer, publish Debug worker/Loader, package artifacts/mados-debug-session-tools/win-unpacked.
- [x] Native startup/shutdown, verify Debug DLL hashes, write report and link EXE.

## Progress / ledger

- Pre-flight: Task 1 and 2 share only CSS tokens and delivery pipeline. App passes current connection; Tools keeps worker APIs unchanged. Existing recap already waits for launch dock to finish, so retain its lifecycle and only align presentation.
- Baseline: previous delivery has 147 TS tests and 76 C# tests passing; unchanged dirty feature branch retained.

- Completed: current-game snapshot hook/dock, Tools steps, profile overview, guarded configuration drafts and collapsible logs.
- Review: status/config/backups now load independently; running server can be stopped after config failure. Import/retry confirm unsaved-draft replacement; same-profile updates reload config. Regression tests observed failing before fixes, passing after. Final reviewer: no blocking findings.
- Verification: typecheck, 155 TypeScript tests and 76 C# tests passed. Electron fixture smoke covers game-to-recap, Tools lifecycle/errors, logs, keyboard stage activation, all 5 themes, 800x600, app/OS reduced motion. Screenshots inspected.
- Delivery: artifacts/mados-debug-session-tools/win-unpacked/Mados Launcher.exe. Debug worker and Loader DLL hashes match their bin/Debug outputs. Native packaged smoke: one bundled worker, exit 0, no orphan processes. No commits/pushes. Full live game/CDN download was not run; these UI states were fixture-driven. Existing NU1903 dependency advisories remain in the verification report.