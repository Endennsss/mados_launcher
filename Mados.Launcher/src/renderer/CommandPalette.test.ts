import { describe, expect, it } from "vitest";
import { buildCommandPaletteCommands, filterCommandPaletteCommands, type CommandPaletteItem } from "./CommandPalette";
import type { Server } from "../contracts/launcher";

const custom = (id: string, label: string, keywords: string[] = []): CommandPaletteItem => ({ id, label, keywords, action: { type: "navigate", tab: "home" } });

describe("command palette model", () => {
  it("merges favorites with catalog servers, strips private address parts and opens details instead of launching", () => {
    const commands = buildCommandPaletteCommands({
      servers: [{ address: "ss14://user:secret@station:1212?token=secret#private", name: "Mados Station", playerCount: 42, softMaxPlayerCount: 80, status: "online", tags: ["lang:ru"], map: "Box", mode: "Sandbox", pingMs: 31 } as Server],
      favorites: [{ address: "ss14://station", name: "Моя станция", raiseTime: "2026-01-01" }, { address: "ss14://offline", name: "Offline station", raiseTime: "2026-01-01" }],
    });
    const results = filterCommandPaletteCommands(commands, "station").filter(item => item.action.type === "open-server");
    expect(results).toHaveLength(2);
    const server = results.find(item => item.label === "Mados Station")!;
    expect(server.group).toBe("favorites");
    expect(server.action).toMatchObject({ type: "open-server", server: { address: "ss14://station", playerCount: 42, map: "Box" } });
    expect(JSON.stringify(server)).not.toContain("secret");
    expect(filterCommandPaletteCommands(commands, "моя станция")[0].id).toBe(server.id);
    expect(filterCommandPaletteCommands(commands, "box sandbox")[0].id).toBe(server.id);
  });

  it("finds specific settings through human synonyms and opens the exact target", () => {
    const commands = buildCommandPaletteCommands();
    expect(filterCommandPaletteCommands(commands, "анимации")[0].action).toEqual({ type: "open-setting", settingId: "motion" });
    expect(filterCommandPaletteCommands(commands, "пинг дискорд")[0].action).toEqual({ type: "open-setting", settingId: "presence" });
    expect(filterCommandPaletteCommands(commands, "language")[0].action).toEqual({ type: "open-setting", settingId: "language" });
  });

  it("does not index unsafe servers or destructive actions", () => {
    const commands = buildCommandPaletteCommands({ favorites: [{address:"file:///private",name:"Private",raiseTime:"2026-01-01"}] });
    expect(filterCommandPaletteCommands(commands,"private")).toEqual([]);
    expect(filterCommandPaletteCommands(commands,"удалить")).toEqual([]);
  });
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
