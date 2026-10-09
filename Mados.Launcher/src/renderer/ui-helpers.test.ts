import { describe, expect, it } from "vitest";
import type { Server, ServerDetails } from "../contracts/launcher";
import { mergeServerDetails, sanitizeServerAddress } from "./ui-helpers";

const server: Server = {
  address: "ss14://station.example",
  name: "Old name",
  playerCount: 4,
  softMaxPlayerCount: 80,
  roundStartTime: null,
  runLevel: null,
  tags: [],
  status: "online",
  hubAddress: "hub",
};

describe("server details", () => {
  it("uses refreshed details for the title and connection state", () => {
    const details: ServerDetails = {
      status: "offline",
      playerCount: 0,
      map: "Delta",
      mode: "Roleplay",
    };

    expect(mergeServerDetails(server, details)).toMatchObject({
      name: "Old name",
      status: "offline",
      playerCount: 0,
      map: "Delta",
      mode: "Roleplay",
    });
  });

  it("prefers a refreshed server name when one is available", () => {
    expect(mergeServerDetails(server, { name: "Fresh name" })).toMatchObject({ name: "Fresh name" });
  });

  it("keeps the catalog name when the status endpoint has no name", () => {
    expect(mergeServerDetails(server, { name: null })).toMatchObject({ name: "Old name" });
  });
});

describe("server address display", () => {
  it("removes credentials, query and fragment before persistence", () => {
    expect(sanitizeServerAddress("ss14://user:pass@station.example/round?token=secret#x")).toBe("ss14://station.example/round");
    expect(sanitizeServerAddress("ss14://station.example/path//")).toBe("ss14://station.example/path");
  });

  it("keeps invalid addresses unavailable instead of exposing them", () => {
    expect(sanitizeServerAddress("not-a-server")).toBe("");
  });
});
