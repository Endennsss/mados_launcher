import { z } from "zod";

export const INSTALLER_METHODS = [
  "release.check",
  "install.chooseDirectory",
  "install.getDefaultDirectory",
  "install.start",
  "install.cancel",
  "install.openDirectory",
  "app.quit",
] as const;

export const INSTALLER_STAGES = [
  "checking",
  "ready",
  "downloading",
  "extracting",
  "installing",
  "launching",
  "completed",
  "error",
] as const;

export type InstallerMethod = (typeof INSTALLER_METHODS)[number];
export type InstallerStage = (typeof INSTALLER_STAGES)[number];

export type ReleaseInfo = {
  tagName: string;
  version: string;
  name: string;
  publishedAt: string;
  sizeBytes: number;
  assetName: string;
  assetUrl: string;
  digest?: string;
};

export type DownloadProgress = {
  receivedBytes: number;
  totalBytes: number | null;
  percent: number | null;
};

export type InstallerError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type InstallerReply<T> = { ok: true; value: T } | { ok: false; error: InstallerError };

export class InstallerFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = "InstallerFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

export const releaseInfoSchema = z.object({
  tagName: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  publishedAt: z.string().datetime({ offset: true }),
  sizeBytes: z.number().int().nonnegative(),
  assetName: z.literal("Mados.Launcher.Windows.x64.zip"),
  assetUrl: z.string().url().refine((value) => value.startsWith("https://"), "HTTPS is required"),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
});

export const installDirectorySchema = z.string().trim().min(1);

export const downloadProgressSchema = z.object({
  receivedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive().nullable(),
  percent: z.number().min(0).max(100).nullable(),
});

export const installerErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});

export type InstallerEventMap = {
  stage: InstallerStage;
  progress: DownloadProgress;
  error: InstallerError;
};

export type InstallerEventHandler<T> = (value: T) => void;

export type InstallerApi = {
  checkRelease: () => Promise<ReleaseInfo>;
  chooseDirectory: () => Promise<string | null>;
  getDefaultDirectory: () => Promise<string>;
  startInstall: (directory: string) => Promise<void>;
  cancelInstall: () => Promise<void>;
  openDirectory: (directory: string) => Promise<void>;
  quit: () => Promise<void>;
  onStage: (handler: InstallerEventHandler<InstallerStage>) => () => void;
  onProgress: (handler: InstallerEventHandler<DownloadProgress>) => () => void;
  onError: (handler: InstallerEventHandler<InstallerError>) => () => void;
};

declare global {
  interface Window {
    madosInstaller: InstallerApi;
  }
}
