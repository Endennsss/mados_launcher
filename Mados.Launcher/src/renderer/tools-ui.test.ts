import { describe, expect, it } from "vitest";
import type { LocalServerConfig } from "../contracts/launcher";
import { buildVariantLabel, configChanges, formatBuildSize, importStageLabel, isLocalProcessActive } from "./tools-ui";

describe("tools UI helpers", () => {
  it("formats CDN build metadata and sizes", () => {
    expect(buildVariantLabel({ id: "1", platform: "windows", architecture: "x64", version: "1", downloadUrl: "https://example.test/a.zip", sizeBytes: 1024 * 1024, publishedAt: null })).toBe("Windows · x64");
    expect(formatBuildSize(1024 * 1024 * 12)).toBe("12 МБ");
    expect(formatBuildSize(null)).toBe("Размер не указан");
  });

  it("knows when a process is active and maps progress stages", () => {
    expect(isLocalProcessActive("running")).toBe(true);
    expect(isLocalProcessActive("ready")).toBe(false);
    expect(importStageLabel("extracting")).toBe("Распаковываем файлы");
  });

  it("shows changed fields or raw TOML in preview", () => {
    const base: LocalServerConfig = { name: "Station", hostname: null, bindAddress: "127.0.0.1", port: 1212, maxPlayers: 30, authMode: "Optional", rawToml: "[net]" };
    expect(configChanges(base, { ...base, port: 1213 }, "fields")).toEqual(["Порт: 1212 → 1213"]);
    expect(configChanges(base, { ...base, rawToml: "[net]\nport=1213" }, "raw")).toEqual(["Изменён текст server_config.toml"]);
  });
});
