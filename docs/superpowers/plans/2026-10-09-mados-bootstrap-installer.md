# Mados Launcher Bootstrap Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate styled Electron installer that downloads the latest stable Windows x64 Mados Launcher ZIP from GitHub Releases, safely installs it into a user-selected directory, and launches it.

**Architecture:** `Mados.Installer` is an independent Electron + React + TypeScript package. Main process owns GitHub API, download, cancellation, ZIP validation/extraction, staged replacement, backups, and launch; preload exposes a typed allowlist; renderer only renders state and invokes approved commands. The existing `Mados.Launcher` build and release assets remain unchanged.

**Tech Stack:** Electron 33, React 18, TypeScript, Vite, electron-builder, Vitest, Node `fetch`/streams, `fflate` ZIP reader, Lucide React.

**Spec:** `docs/superpowers/specs/2026-10-09-mados-bootstrap-installer-design.md`

## Global Constraints

- The installer must not bundle `Mados.Launcher/dist`, the C# worker, or the release ZIP contents.
- The source is `https://api.github.com/repos/Endennsss/mados_launcher/releases/latest` and the exact asset is `Mados.Launcher.Windows.x64.zip`.
- Draft and prerelease GitHub releases are rejected.
- Downloads are HTTPS-only and use the URL returned by the GitHub API.
- ZIP entries must reject traversal, absolute paths, and symbolic links before writing files.
- Existing `data`, `launcher`, and local user databases must survive an update; `resources/app.asar` must be replaced by the new runtime.
- Renderer has no direct access to `fs`, `process`, `child_process`, or arbitrary URLs.
- Changes remain local; do not create a commit or push.

## Review Focus

- GitHub returns a prerelease, draft, missing asset, or malformed response: `release-client` tests assert a typed failure instead of downloading anything.
- A ZIP contains `../`, an absolute path, or a symbolic-link entry: extraction tests assert no file escapes staging and the install is aborted.
- Download cancellation or a truncated response occurs: download tests assert cleanup and no replacement of an existing install.
- An existing install contains user data while a new release is installed: replacement tests assert protected directories are restored and old install remains recoverable.
- Renderer sends an unknown IPC method or malformed path: main/preload tests assert it is rejected without filesystem access.

### Task 1: Installer package scaffold and secure IPC contract

**Files:**
- Create: `Mados.Installer/package.json`
- Create: `Mados.Installer/package-lock.json`
- Create: `Mados.Installer/tsconfig.main.json`
- Create: `Mados.Installer/tsconfig.renderer.json`
- Create: `Mados.Installer/vite.config.ts`
- Create: `Mados.Installer/vitest.config.ts`
- Create: `Mados.Installer/src/contracts/installer.ts`
- Create: `Mados.Installer/src/contracts/installer.schema.json`
- Create: `Mados.Installer/src/preload/preload.ts`
- Create: `Mados.Installer/src/main/main.ts`
- Test: `Mados.Installer/src/contracts/installer.test.ts`

**Interfaces:**
- Produces `ReleaseInfo`, `InstallDirectory`, `DownloadProgress`, `InstallerStage`, `InstallerError`, and the `InstallerApi` preload surface used by later tasks.
- `InstallerApi.checkRelease(): Promise<ReleaseInfo>`
- `InstallerApi.chooseDirectory(): Promise<string | null>`
- `InstallerApi.startInstall(directory: string): Promise<void>`
- `InstallerApi.cancelInstall(): Promise<void>`
- `InstallerApi.onStage`, `onProgress`, and `onError` return unsubscribe functions.

- [ ] **Step 1: Write the failing contract test**

  Assert that the method allowlist contains exactly `release.check`, `install.chooseDirectory`, `install.start`, `install.cancel`, `install.openDirectory`, and `app.quit`; that `InstallerStage` contains the eight documented states; and that an invalid renderer payload is rejected.

- [ ] **Step 2: Run the contract test to verify it fails**

  Run `npm test -- --run src/contracts/installer.test.ts` from `Mados.Installer`.
  Expected: FAIL because the package and contract exports do not exist.

- [ ] **Step 3: Implement the package and contract**

  Add scripts `dev`, `build`, `typecheck`, `test`, `dist:dir`, and `dist`. Configure Electron main/preload TypeScript output and renderer Vite output. Define zod or equivalent runtime schemas for release, install, progress, stage, and error payloads. In preload expose only the typed methods and event subscriptions through `contextBridge`; set `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and a restrictive CSP in the renderer entrypoint.

- [ ] **Step 4: Run the contract test to verify it passes**

  Run `npm test -- --run src/contracts/installer.test.ts` and `npm run typecheck`.
  Expected: all contract assertions pass and both TypeScript projects typecheck.

### Task 2: GitHub release discovery and secure ZIP download

**Files:**
- Create: `Mados.Installer/src/main/release-client.ts`
- Create: `Mados.Installer/src/main/download.ts`
- Test: `Mados.Installer/src/main/release-client.test.ts`
- Test: `Mados.Installer/src/main/download.test.ts`
- Modify: `Mados.Installer/src/main/main.ts`

**Interfaces:**
- `fetchLatestRelease(fetchImpl?: typeof fetch): Promise<ReleaseInfo>`
- `downloadAsset(assetUrl: string, destination: string, signal: AbortSignal, onProgress: (progress: DownloadProgress) => void, fetchImpl?: typeof fetch): Promise<void>`
- Main IPC handlers call only these functions and translate thrown errors to `InstallerError`.

- [ ] **Step 1: Write failing release and download tests**

  Cover stable release selection, prerelease/draft rejection, exact asset selection, HTTPS validation, streamed byte progress, non-2xx responses, missing content length, and abort cleanup.

- [ ] **Step 2: Run the focused tests to verify they fail**

  Run `npm test -- --run src/main/release-client.test.ts src/main/download.test.ts`.
  Expected: FAIL because release and download modules do not exist.

- [ ] **Step 3: Implement release discovery and download**

  Use the fixed GitHub API URL and `User-Agent: Mados-Installer/<version>`. Reject every URL that is not HTTPS. Stream the response body to a file with an `AbortSignal`, report `receivedBytes`, `totalBytes`, and `percent`, and delete partial files on any error or cancellation. Do not log response bodies or authorization headers.

- [ ] **Step 4: Run the focused tests to verify they pass**

  Run the two focused test files and confirm all release/download cases pass.

### Task 3: ZIP validation, staged extraction, backup, and replacement

**Files:**
- Create: `Mados.Installer/src/main/zip-safety.ts`
- Create: `Mados.Installer/src/main/install-files.ts`
- Test: `Mados.Installer/src/main/zip-safety.test.ts`
- Test: `Mados.Installer/src/main/install-files.test.ts`

**Interfaces:**
- `validateArchiveEntry(entryName: string, isSymlink: boolean): string`
- `extractArchive(zipPath: string, stagingPath: string, onStage: (stage: InstallerStage) => void): Promise<string>`
- `installStagedApp(stagingPath: string, installPath: string): Promise<{ executablePath: string; backupPath: string | null }>`
- Protected paths are the exact top-level names `data`, `launcher`, plus files ending in `.db`; Electron `resources/app.asar` is replacement content.

- [ ] **Step 1: Write failing path-safety and replacement tests**

  Assert traversal and absolute paths throw, symlink entries throw, normal nested paths are accepted, a fake ZIP extracts into staging, the expected executable is required, protected data survives replacement, backups are created, and a replacement failure restores the previous installation.

- [ ] **Step 2: Run the focused tests to verify they fail**

  Run `npm test -- --run src/main/zip-safety.test.ts src/main/install-files.test.ts`.
  Expected: FAIL because the safety and installation modules do not exist.

- [ ] **Step 3: Implement validation and staged installation**

  Use `fflate` to read ZIP entries, normalize with `path.win32`, reject absolute/drive-letter paths, `..` segments, and Unix symlink mode bits before creating files. Extract into a unique temporary sibling directory. Require `Mados Launcher.exe`. If the target exists, rename it to a timestamped backup, move staging into place, and restore protected paths from the backup. On any replacement error, restore the backup and leave the original install usable. Always remove incomplete staging directories.

- [ ] **Step 4: Run the focused tests to verify they pass**

  Run both focused test files and confirm the old-install recovery and protected-data assertions pass.

### Task 4: Installer orchestration and Electron lifecycle

**Files:**
- Create: `Mados.Installer/src/main/installer-service.ts`
- Modify: `Mados.Installer/src/main/main.ts`
- Modify: `Mados.Installer/src/contracts/installer.ts`
- Test: `Mados.Installer/src/main/installer-service.test.ts`

**Interfaces:**
- `InstallerService.checkRelease(): Promise<ReleaseInfo>`
- `InstallerService.install(directory: string, emit: InstallerEventSink): Promise<string>`
- `InstallerService.cancel(): void`
- `InstallerService.openDirectory(directory: string): Promise<void>`

- [ ] **Step 1: Write failing orchestration tests**

  Assert the stage order `checking → downloading → extracting → installing → launching → completed`, cancellation stops before replacement, errors emit `error` and clean temporary files, the default directory is platform-appropriate, and launch uses only the verified `Mados Launcher.exe` path.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run `npm test -- --run src/main/installer-service.test.ts`.
  Expected: FAIL because `InstallerService` does not exist.

- [ ] **Step 3: Implement service and lifecycle**

  Compose Tasks 2 and 3 behind injectable release/download/extraction functions. Wire IPC handlers with runtime validation and a single active install guard. Use `dialog.showOpenDialog` for directory selection, `shell.openPath` only for the selected directory, and `spawn` with the verified executable and `detached: true` after successful install. Implement single-instance behavior for the installer and clean cancellation on `before-quit`.

- [ ] **Step 4: Run focused tests and typecheck**

  Run `npm test -- --run src/main/installer-service.test.ts` and `npm run typecheck`.
  Expected: all orchestration assertions pass.

### Task 5: Styled React installer interface

**Files:**
- Create: `Mados.Installer/src/renderer/index.html`
- Create: `Mados.Installer/src/renderer/main.tsx`
- Create: `Mados.Installer/src/renderer/App.tsx`
- Create: `Mados.Installer/src/renderer/styles.css`
- Create: `Mados.Installer/src/renderer/assets/cat-logo.png`
- Test: `Mados.Installer/src/renderer/App.test.tsx`

**Interfaces:**
- Consumes `window.madosInstaller` from Task 1 and the stage/progress/error events from Task 4.
- Produces the visible release card, directory picker, install/cancel/retry actions, stage timeline, progress bar, and completion action.

- [ ] **Step 1: Write failing renderer tests**

  Assert latest version and ZIP size are shown, directory selection updates the field, the install button is disabled without a release/directory, progress renders percent and bytes, cancelling calls `cancelInstall`, errors show retry, and reduced-motion class is applied when requested.

- [ ] **Step 2: Run renderer tests to verify they fail**

  Run `npm test -- --run src/renderer/App.test.tsx`.
  Expected: FAIL because the installer renderer does not exist.

- [ ] **Step 3: Implement the styled UI**

  Reuse the Mados design tokens, Noto Sans fallback, 20px window radius, red accent, Lucide icons, and the cat asset. Keep the drag region separate from controls. Use semantic icon animation classes: Download only while downloading, PackageOpen after extraction, FolderOpen on hover, RefreshCw once on retry; disable transform animations for `prefers-reduced-motion`.

- [ ] **Step 4: Run renderer tests and production build**

  Run `npm test -- --run src/renderer/App.test.tsx`, `npm run typecheck`, and `npm run build`.
  Expected: all UI assertions pass and `dist/main`, `dist/preload`, and `dist/renderer` are generated.

### Task 6: Packaging, smoke verification, and documentation

**Files:**
- Create: `Mados.Installer/electron-builder.yml`
- Create: `Mados.Installer/README.md`
- Create: `Mados.Installer/scripts/verify-package.mjs`
- Modify: `README.md`
- Test: `Mados.Installer/scripts/verify-package.test.ts`

**Interfaces:**
- `npm run dist:dir` produces `artifacts/mados-installer-debug/win-unpacked/Mados Installer.exe`.
- `npm run dist` produces `artifacts/mados-installer/Mados.Installer.Windows.x64.exe`.

- [ ] **Step 1: Write failing packaging verification**

  Assert the packaged installer contains no `Mados Launcher.exe`, no `resources/worker`, and does contain the installer main/preload/renderer bundles and cat asset.

- [ ] **Step 2: Run the verification to verify it fails**

  Run `npm test -- --run scripts/verify-package.test.ts`.
  Expected: FAIL because the packaging project does not exist.

- [ ] **Step 3: Implement packaging and docs**

  Configure a frameless Windows x64 installer package without app payload files, add debug unpacked and release installer scripts, and document local commands plus the expected GitHub release asset name. Add a script that starts the packaged installer with a temporary mock GitHub response only for smoke verification; production code always uses the real GitHub URL.

- [ ] **Step 4: Run the full installer checks**

  From `Mados.Installer` run `npm test`, `npm run typecheck`, `npm run build`, `npm run dist:dir`, and the package verification script. Then run the unpacked installer once, confirm the rounded UI opens, and close it without leaving a child process.

## Final Verification

- Run `npm test` and `npm run typecheck` in `Mados.Installer`.
- Run the existing `npm run build` in `Mados.Launcher` to confirm the launcher remains buildable.
- Inspect `artifacts/mados-installer-debug/win-unpacked` and assert no launcher payload is embedded.
- Manually verify the UI against a local test ZIP or the latest public release: choose folder, download progress, extraction, launch, cancellation, retry, and preservation of an existing `data` directory.
- Leave all modifications uncommitted and unpushed.
