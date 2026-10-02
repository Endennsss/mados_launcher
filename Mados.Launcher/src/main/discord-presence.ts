import { Client } from "@xhayper/discord-rpc";
import { presenceSnapshotSchema } from "../contracts/schema";
import type { PresenceSnapshot, WorkerEvent } from "../contracts/launcher";

export const DISCORD_CLIENT_ID = "1555589477492199434";
export const DISCORD_ASSET_KEY = "mados-cat";

export type DiscordPresenceStatus = "connected" | "unavailable" | "disabled";

export type DiscordActivity = {
  details: string;
  state: string;
  startTimestamp?: Date;
  largeImageKey?: string;
  largeImageText?: string;
};

const MAX_TEXT_LENGTH = 128;

export function sanitizePresenceText(value: string | null | undefined, fallback: string): string {
  const clean = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.length > MAX_TEXT_LENGTH ? `${clean.slice(0, MAX_TEXT_LENGTH - 1)}…` : clean;
}

function shortAddress(address: string | null | undefined): string {
  if (!address) return "Не указано";
  try {
    const parsed = new URL(address);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const result = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    return sanitizePresenceText(result, "Не указано");
  } catch {
    return sanitizePresenceText(address.split(/[?#]/, 1)[0], "Не указано");
  }
}

function displayValue(value: string | null | undefined, fallback = "Не указано"): string {
  return sanitizePresenceText(value, fallback);
}

export function buildDiscordActivity(snapshot: PresenceSnapshot): DiscordActivity {
  const server = displayValue(snapshot.serverName, shortAddress(snapshot.address));
  const map = displayValue(snapshot.map);
  const mode = displayValue(snapshot.mode);
  const online = snapshot.playerCount == null
    ? "Онлайн —"
    : `Онлайн ${snapshot.playerCount}${snapshot.softMaxPlayerCount && snapshot.softMaxPlayerCount > 0 ? `/${snapshot.softMaxPlayerCount}` : ""}`;
  const ping = snapshot.pingMs == null ? "Ping —" : `Ping ${Math.max(0, Math.round(snapshot.pingMs))} ms`;
  const nickname = displayValue(snapshot.accountName, "Не указано");

  switch (snapshot.state) {
    case "playing":
      return {
        details: sanitizePresenceText(`Играет на ${server} · ${map}`, "Mados Launcher"),
        state: sanitizePresenceText((snapshot.showNickname ? [nickname, mode, online, ping] : [mode, online, ping]).join(" · "), "Mados Launcher"),
        ...(snapshot.startedAt && !Number.isNaN(Date.parse(snapshot.startedAt)) ? { startTimestamp: new Date(snapshot.startedAt) } : {}),
        largeImageKey: DISCORD_ASSET_KEY,
        largeImageText: "Mados Launcher",
      };
    case "connecting":
      return { details: sanitizePresenceText(`Mados Launcher · ${server}`, "Mados Launcher"), state: "Подключается", largeImageKey: DISCORD_ASSET_KEY, largeImageText: "Mados Launcher" };
    case "updating":
      return { details: sanitizePresenceText(`Mados Launcher · ${server}`, "Mados Launcher"), state: "Обновляет игру", largeImageKey: DISCORD_ASSET_KEY, largeImageText: "Mados Launcher" };
    default:
      return { details: "Mados Launcher", state: "Выбирает сервер", largeImageKey: DISCORD_ASSET_KEY, largeImageText: "Mados Launcher" };
  }
}

export class DiscordPresenceService {
  private client: Client | undefined;
  private snapshot: PresenceSnapshot | undefined;
  private connecting: Promise<Client | undefined> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 5_000;
  private stopped = false;
  private rendering: Promise<void> | undefined;

  public constructor(private readonly onStatus: (status: DiscordPresenceStatus) => void) {}

  public handleWorkerEvent(event: WorkerEvent): void {
    if (event.event !== "presence.updated") return;
    const parsed = presenceSnapshotSchema.safeParse(event.data);
    if (!parsed.success) return;
    this.snapshot = parsed.data;
    if (!this.snapshot.enabled) {
      void this.disable();
      return;
    }
    void this.render();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetryTimer();
    await this.disable();
  }

  private async render(): Promise<void> {
    if (this.rendering) return this.rendering;
    this.rendering = this.renderInternal().finally(() => { this.rendering = undefined; });
    return this.rendering;
  }

  private async renderInternal(): Promise<void> {
    const snapshot = this.snapshot;
    if (this.stopped || !snapshot?.enabled) return;
    const client = await this.ensureClient();
    if (!client || this.stopped || !this.snapshot?.enabled) return;
    try {
      await client.user?.setActivity(buildDiscordActivity(this.snapshot));
      this.onStatus("connected");
    } catch {
      this.markUnavailable();
    }
  }

  private async ensureClient(): Promise<Client | undefined> {
    if (this.client?.isConnected) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ clientId: DISCORD_CLIENT_ID });
      client.on("connected", () => this.onStatus("connected"));
      client.on("ready", () => this.onStatus("connected"));
      client.on("disconnected", () => this.markUnavailable());
      try {
        await client.login();
        if (this.stopped || !this.snapshot?.enabled) {
          await client.destroy();
          return undefined;
        }
        this.client = client;
        this.retryDelay = 5_000;
        this.onStatus("connected");
        return client;
      } catch {
        try { await client.destroy(); } catch { /* Discord may already be closed. */ }
        this.markUnavailable();
        this.scheduleRetry();
        return undefined;
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  private async disable(): Promise<void> {
    this.clearRetryTimer();
    const client = this.client;
    this.client = undefined;
    if (client) {
      try { await client.user?.clearActivity(); } catch { /* Discord is optional. */ }
      try { await client.destroy(); } catch { /* Discord is optional. */ }
    }
    this.onStatus(this.stopped || this.snapshot?.enabled === false ? "disabled" : "unavailable");
  }

  private markUnavailable(): void {
    this.client = undefined;
    this.onStatus("unavailable");
    if (!this.stopped && this.snapshot?.enabled) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped || !this.snapshot?.enabled) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(30_000, this.retryDelay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.render();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
