// @vitest-environment jsdom
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { DownloadProgress, InstallerError, InstallerStage, ReleaseInfo } from "../contracts/installer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const release: ReleaseInfo = {
  tagName: "v0.40.3",
  version: "0.40.3",
  name: "Mados Launcher 0.40.3",
  publishedAt: "2026-10-09T12:00:00.000Z",
  sizeBytes: 2_048_000,
  assetName: "Mados.Launcher.Windows.x64.zip",
  assetUrl: "https://example.test/release.zip",
};

type Handlers = {
  stage?: (stage: InstallerStage) => void;
  progress?: (progress: DownloadProgress) => void;
  error?: (error: InstallerError) => void;
};

let handlers: Handlers;
let api: typeof window.madosInstaller;

beforeEach(() => {
  handlers = {};
  api = {
    checkRelease: vi.fn(async () => release),
    chooseDirectory: vi.fn(async () => "C:\\Mados Launcher"),
    getDefaultDirectory: vi.fn(async () => ""),
    startInstall: vi.fn(async () => undefined),
    cancelInstall: vi.fn(async () => undefined),
    openDirectory: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    onStage: vi.fn((handler) => { handlers.stage = handler; return () => undefined; }),
    onProgress: vi.fn((handler) => { handlers.progress = handler; return () => undefined; }),
    onError: vi.fn((handler) => { handlers.error = handler; return () => undefined; }),
  };
  window.madosInstaller = api;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
});

afterEach(() => cleanup());

describe("installer renderer", () => {
  it("shows the latest release and waits for a directory before enabling install", async () => {
    render(<App />);
    await screen.findByText("Mados Launcher 0.40.3");
    expect(screen.getByRole("button", { name: "Установить" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Выбрать папку" }));
    await waitFor(() => expect(screen.getByDisplayValue("C:\\Mados Launcher")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Установить" }).hasAttribute("disabled")).toBe(false);
  });

  it("renders streamed progress and allows cancellation", async () => {
    render(<App />);
    await screen.findByText("Mados Launcher 0.40.3");
    fireEvent.click(screen.getByRole("button", { name: "Выбрать папку" }));
    await waitFor(() => expect(screen.getByDisplayValue("C:\\Mados Launcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Установить" }));
    act(() => handlers.stage?.("downloading"));
    act(() => handlers.progress?.({ receivedBytes: 1_024_000, totalBytes: 2_048_000, percent: 50 }));
    expect(screen.getByText("50%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(api.cancelInstall).toHaveBeenCalledOnce();
  });

  it("shows retry after an installer error", async () => {
    render(<App />);
    await screen.findByText("Mados Launcher 0.40.3");
    act(() => handlers.error?.({ code: "DOWNLOAD_HTTP", message: "Сеть недоступна", retryable: true }));
    expect(screen.getByText("Сеть недоступна")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Повторить" })); await Promise.resolve(); });
    expect(api.checkRelease).toHaveBeenCalledTimes(2);
  });

  it("marks the shell as reduced motion when the OS requests it", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
    render(<App />);
    await screen.findByText("Mados Launcher 0.40.3");
    expect(document.querySelector(".installer-shell")?.classList.contains("reduced-motion")).toBe(true);
  });
});
