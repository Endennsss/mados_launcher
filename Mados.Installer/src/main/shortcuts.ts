import { dirname, join } from "node:path";

export type ShortcutOptions = {
  desktopDirectory: string;
  appDataDirectory: string;
  executablePath: string;
  makeDirectory: (path: string) => Promise<void>;
  writeShortcut: (path: string, operation: "create", options: {
    target: string;
    cwd: string;
    description: string;
    icon: string;
    iconIndex: number;
  }) => boolean;
};

export function getShortcutPaths(desktopDirectory: string, appDataDirectory: string): string[] {
  return [
    join(desktopDirectory, "Mados Launcher.lnk"),
    join(appDataDirectory, "Microsoft", "Windows", "Start Menu", "Programs", "Mados Launcher.lnk"),
  ];
}

export async function createWindowsShortcuts(options: ShortcutOptions): Promise<{ created: string[]; failed: string[] }> {
  const created: string[] = [];
  const failed: string[] = [];
  for (const shortcutPath of getShortcutPaths(options.desktopDirectory, options.appDataDirectory)) {
    try {
      await options.makeDirectory(dirname(shortcutPath));
      const written = options.writeShortcut(shortcutPath, "create", {
        target: options.executablePath,
        cwd: dirname(options.executablePath),
        description: "Mados Launcher",
        icon: options.executablePath,
        iconIndex: 0,
      });
      (written ? created : failed).push(shortcutPath);
    } catch {
      failed.push(shortcutPath);
    }
  }
  return { created, failed };
}
