import { describe, expect, it, vi } from "vitest";
import { DiscordPresenceService, buildDiscordActivity } from "./discord-presence";
import type { Client } from "@xhayper/discord-rpc";
import type { PresenceSnapshot } from "../contracts/launcher";

const playing: PresenceSnapshot = {
  state: "playing",
  enabled: true,
  showNickname: true,
  accountName: "Ende",
  serverName: "Mados Station",
  address: "ss14://station.example:1212?token=secret",
  playerCount: 12,
  softMaxPlayerCount: 80,
  pingMs: 34,
  map: "Box",
  mode: "Roleplay",
  startedAt: "2026-10-02T12:00:00Z",
};

describe("Discord presence formatting", () => {
  it("includes the requested game fields and strips no user-facing data", () => {
    const activity = buildDiscordActivity(playing);
    expect(activity.details).toBe("Играет на Mados Station · Box");
    expect(activity.state).toContain("Ende · Roleplay · Онлайн 12/80 · Ping 34 ms");
    expect(activity.state).not.toContain("secret");
    expect(activity.startTimestamp).toBeInstanceOf(Date);
  });

  it("uses safe fallbacks for missing server metadata", () => {
    const activity = buildDiscordActivity({ ...playing, serverName: null, address: "ss14://fallback.example:1212?token=secret", map: null, mode: null });
    expect(activity.details).toBe("Играет на fallback.example:1212 · Не указано");
    expect(activity.state).toContain("Не указано");
    expect(activity.details).not.toContain("secret");
  });

  it("omits the nickname when the privacy setting is disabled", () => {
    const activity = buildDiscordActivity({ ...playing, showNickname: false });
    expect(activity.state).toBe("Roleplay · Онлайн 12/80 · Ping 34 ms");
    expect(activity.state).not.toContain("Ende");
  });
});

describe("Discord presence lifecycle", () => {
  it("sets activity on a structured playing event and clears it when disabled", async () => {
    const statuses: string[] = [];
    const fake = {
      isConnected: true,
      user: {
        setActivity: vi.fn(async () => undefined),
        clearActivity: vi.fn(async () => undefined),
      },
      login: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
      on: vi.fn(),
    };
    const service = new DiscordPresenceService((status) => statuses.push(status), () => fake as unknown as Client);

    service.handleWorkerEvent({ v: 1, event: "presence.updated", data: playing });
    await vi.waitFor(() => expect(fake.user.setActivity).toHaveBeenCalledTimes(1));
    expect(statuses).toContain("connected");

    service.handleWorkerEvent({ v: 1, event: "presence.updated", data: { ...playing, enabled: false } });
    await vi.waitFor(() => expect(fake.user.clearActivity).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(statuses.at(-1)).toBe("disabled"));
    await service.stop();
  });
});
