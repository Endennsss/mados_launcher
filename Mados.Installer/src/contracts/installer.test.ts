import { describe, expect, it } from "vitest";
import {
  INSTALLER_METHODS,
  INSTALLER_STAGES,
  installDirectorySchema,
  type InstallerStage,
} from "./installer";

describe("installer IPC contract", () => {
  it("keeps the renderer method allowlist closed", () => {
    expect(INSTALLER_METHODS).toEqual([
      "release.check",
      "install.chooseDirectory",
      "install.getDefaultDirectory",
      "install.start",
      "install.cancel",
      "install.openDirectory",
      "app.quit",
    ]);
  });

  it("exposes every documented lifecycle stage", () => {
    const stages: InstallerStage[] = [
      "checking",
      "ready",
      "downloading",
      "extracting",
      "installing",
      "launching",
      "completed",
      "error",
    ];

    expect(INSTALLER_STAGES).toEqual(stages);
  });

  it("rejects a renderer path that is not a non-empty string", () => {
    expect(installDirectorySchema.safeParse("").success).toBe(false);
    expect(installDirectorySchema.safeParse({ directory: "C:\\Mados" }).success).toBe(false);
    expect(installDirectorySchema.safeParse("C:\\Mados").success).toBe(true);
  });
});
