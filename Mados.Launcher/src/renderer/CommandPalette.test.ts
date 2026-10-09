import { describe, expect, it } from "vitest";
import { buildCommandPaletteCommands, filterCommandPaletteCommands, type CommandPaletteItem } from "./CommandPalette";

const custom = (id: string, label: string, keywords: string[] = []): CommandPaletteItem => ({ id, label, keywords, action: { type: "navigate", tab: "home" } });

describe("command palette model", () => {
  it("contains navigation, refresh, monitoring and optional last-server commands", () => {
    const commands = buildCommandPaletteCommands({ hasLastServer: true });
    expect(commands.map((command) => command.id)).toEqual(expect.arrayContaining([
      "navigate-home", "navigate-servers", "navigate-news", "navigate-playtime", "navigate-settings", "connect-last", "refresh-servers", "open-monitoring",
    ]));
  });

  it("adds profile launch commands with searchable server names", () => {
    const commands = buildCommandPaletteCommands({ profiles: [{ id: "p1", name: "Night Shift", address: "ss14://station", createdAt: "2026-01-01", lastUsedAt: null }] });
    const result = filterCommandPaletteCommands(commands, "night shift");
    expect(result).toHaveLength(1);
    expect(result[0].action).toEqual({ type: "connect-profile", profileId: "p1" });
  });

  it("matches every query token, ignores disabled commands and keeps stable ordering", () => {
    const commands = [custom("a", "Open servers", ["catalog"]), custom("b", "Refresh", ["servers"]), { ...custom("c", "Open secret"), disabled: true }];
    expect(filterCommandPaletteCommands(commands, "servers").map((command) => command.id)).toEqual(["a", "b"]);
    expect(filterCommandPaletteCommands(commands, "refresh servers").map((command) => command.id)).toEqual(["b"]);
    expect(filterCommandPaletteCommands(commands, "missing")).toEqual([]);
  });
});
