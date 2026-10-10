import { describe, expect, it, vi } from "vitest";
import { createWindowsShortcuts, getShortcutPaths } from "./shortcuts";

describe("Windows shortcuts", () => {
  it("places shortcuts on the desktop and in the Start menu", () => {
    expect(getShortcutPaths("C:\\Users\\A\\Desktop", "C:\\Users\\A\\AppData\\Roaming")).toEqual([
      "C:\\Users\\A\\Desktop\\Mados Launcher.lnk",
      "C:\\Users\\A\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Mados Launcher.lnk",
    ]);
  });

  it("creates both shortcuts with the installed executable as target and icon", async () => {
    const makeDirectory = vi.fn(async () => undefined);
    const writeShortcut = vi.fn(() => true);
    const result = await createWindowsShortcuts({
      desktopDirectory: "C:\\Desktop",
      appDataDirectory: "C:\\AppData",
      executablePath: "C:\\Mados Launcher\\Mados Launcher.exe",
      makeDirectory,
      writeShortcut,
    });

    expect(result.failed).toEqual([]);
    expect(result.created).toHaveLength(2);
    expect(writeShortcut).toHaveBeenCalledTimes(2);
    expect(writeShortcut.mock.calls[0]?.[2]).toMatchObject({
      target: "C:\\Mados Launcher\\Mados Launcher.exe",
      cwd: "C:\\Mados Launcher",
      icon: "C:\\Mados Launcher\\Mados Launcher.exe",
    });
  });
});
