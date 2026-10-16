# Mados collections, profiles, states and guide — implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution; review the complete change at the end. Steps use checkboxes for progress.

**Goal:** Deliver the user-approved favorite collections and launch-profile cards, consistent UI states, a short first-use guide, and a runnable Windows x64 Debug package.

**Architecture:** Preserve worker-owned favorites, profile CRUD and server connections. Store only collection layout/group metadata per account and a versioned guide-completion flag in local renderer storage, following existing home customization. Reuse the existing cards, typed IPC, confirmation and selection controls.

**Tech Stack:** Existing React/TypeScript, Lucide, CSS tokens, C# worker, Electron builder.

**Spec:** User-approved in-chat proposal (favorites groups/order, profile cards with inline editing, unified loading/error/empty states), plus this turn's request for a brief first-use guide and Debug EXE.

## Global constraints

- Local work only; no commit, push or release. Preserve all existing uncommitted changes.
- Continue the existing feature checkout: the requested UI depends on its uncommitted work. A clean worktree would omit it.
- No fabricated server metrics or progress; existing connections, accounts and data remain intact.
- Theme tokens, consistent Lucide icons, one-shot semantic motion; both reduced-motion settings disable transforms.
- Account changes must invalidate pending profile updates and isolate collection metadata.
- Guide: four short steps after the first successful login; skippable, persistent completion, reopen from Help. No extra services or dependencies.

## Review focus

- Failed local saves leave the previous collection usable, with an actionable error.
- Pending profile save/use replies cannot mutate or connect under a newly selected account.
- Removing a group moves its servers to the default group without unfavoriting them.
- Empty catalogue and network failure are distinct; refresh retains existing cards.
- Guide and inline editors support keyboard focus, narrow windows and reduced motion.

### Task 1: Favorite collection

Files: create `favorite-collections.ts`, `FavoriteCollection.tsx`, `favorite-collections.test.tsx`, `collections-guide.css`; integrate in `App.tsx` and `HomeDashboard.tsx`.

Interface: versioned `FavoriteLayout` contains group IDs/names and cleaned address order; actual favorites remain worker-owned. `FavoriteCollection` consumes accountId, favorites, real catalog snapshots and existing connect/details/remove callbacks. Home respects the collection order with existing pins taking priority.

- [x] Test account isolation, normalization, move order, deletion without lost favorites, save failure and keyboard controls.
- [x] Implement default groups Основные / С друзьями / Попробовать, custom groups, group assignment, drag reorder with arrow-button alternative, local persistence.
- [x] Integrate catalogue collection entry and Home manage entry, then run focused tests.

### Task 2: Profile cards

Files: modify `LaunchProfiles.tsx`; create `useLaunchProfiles.ts`, component/hook tests; replace App profile callbacks.

Interface: keep public worker methods and `LaunchProfilesProps`; add loading/error/retry presentation. Hook actions reject on failure so inline drafts persist; connection uses current account only.

- [x] Test inline edit and validation, rejected saves retaining drafts, duplicate-action guard, delayed account-switch replies.
- [x] Implement compact cards, primary Play, inline edit/create, save feedback, last-run information and existing confirmation removal.
- [x] Integrate every existing profile surface (Home, Servers, Tools, Ctrl+K); run focused tests.

### Task 3: Shared UI states

Files: create `ViewState.tsx`; integrate App catalogue/Home/offline, news, playtime and tools where their current state blocks exist.

Interface: shared empty/error/loading state with icon/title/description, optional retry/action, optional expandable details; loading placeholders are actual request states, never progress simulations.

- [x] Verify a failed catalogue request offers retry instead of only filter reset; previous cards remain on refresh failure.
- [x] Replace duplicated state surfaces, add matching skeleton styles and accessible status/alert semantics.
- [x] Verify narrow layout, keyboard and both reduced-motion modes in Electron.

### Task 4: First-use guide and handoff

Files: create `LauncherGuide.tsx` and tests; integrate App help/first login; update interface guide.

- [x] Test completion and skip persistence, replay, storage failure and focus restoration.
- [x] Add four brief steps: find a server; organize favorites; launch profiles; Ctrl+K/settings/playtime/tools. Explain using existing icon-based illustrations.
- [x] Review complete change, run TS typecheck/full tests, C# tests, visual and real-worker smoke.
- [x] Publish Debug worker and Loader locally; package `artifacts/mados-debug-collections-guide/win-unpacked`; verify native startup/shutdown and Debug hash; link EXE.

## Progress / rulings

- Planning: existing APIs and surfaces inspected. No new worker/database migration is required for layout metadata.
- Ruling: guide opens after successful login so it describes usable controls; one completion flag per local installation, independent of account switching.
- Ruling: continue this user-owned dirty feature checkout; do not create commits or move its changes to a clean worktree.

- Implemented collection groups/order, inline profile cards, shared states and the four-step guide.
- Review caught an auth-switch race and disabled-opener focus loss. Fixed with a pre-IPC auth revision guard and post-commit focus restoration; regression tests pass.
- Verification so far: 147 TypeScript tests, typecheck, 76 C# tests, production renderer bundling with explicitly Debug worker/Loader publish; Electron fixture smoke verifies groups/drag, profile retry, guide persistence/replay, theme tokens, both reduced-motion modes and 800x600 layout.
- Packaging and native startup/shutdown passed: one real Debug worker, exit code 0, no orphan processes; both bundled DLL hashes match current Debug publish. Existing NU1903 SQLitePCLRaw/Tmds.DBus dependency warnings remain outside this UI change.
- Delivered locally: artifacts/mados-debug-collections-guide/win-unpacked/Mados Launcher.exe; verification-report.json records test scope and existing dependency warnings. No commit or push.
