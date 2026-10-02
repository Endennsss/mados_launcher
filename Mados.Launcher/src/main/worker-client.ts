import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { workerEventSchema, workerResponseSchema } from "../contracts/schema";
import type { WorkerError, WorkerEvent } from "../contracts/launcher";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export class WorkerClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | undefined;
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly ready: Promise<void>;
  private markReady!: () => void;
  private markReadyError!: (error: Error) => void;

  public constructor() {
    super();
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.markReady = resolveReady;
      this.markReadyError = rejectReady;
    });
  }

  public start(): void {
    if (this.process) return;

    const spec = workerSpec();
    this.process = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        SS14_LAUNCHER_APPDATA_NAME: process.env.SS14_LAUNCHER_APPDATA_NAME ?? "launcher",
      },
    });

    let buffer = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.handleLine(line);
        newline = buffer.indexOf("\n");
      }
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        console.error(`[mados-worker] ${line}`);
      }
    });
    this.process.on("error", (error) => {
      this.markReadyError(error);
      this.rejectAll(error);
      this.emit("process-error", error);
    });
    this.process.on("exit", (code, signal) => {
      const error = new Error(`Launcher worker exited (${code ?? "signal " + signal})`);
      this.markReadyError(error);
      this.rejectAll(error);
      this.emit("process-exit", { code, signal });
      this.process = undefined;
    });
  }

  public async invoke<T>(method: string, params?: unknown): Promise<T> {
    await this.ready;
    if (!this.process?.stdin.writable) {
      throw new Error("Launcher worker is not running");
    }

    const id = String(++this.sequence);
    const payload = JSON.stringify({ v: 1, id, method, params });
    return new Promise<T>((resolveResponse, rejectResponse) => {
      this.pending.set(id, { resolve: resolveResponse as (value: unknown) => void, reject: rejectResponse });
      this.process?.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        rejectResponse(error);
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.process) return;
    try {
      await this.invoke("app.shutdown");
    } catch {
      // The process may already be gone during application shutdown.
    }
    this.process.kill();
    this.process = undefined;
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.error("[mados-worker] received invalid JSON", line);
      return;
    }

    const event = workerEventSchema.safeParse(parsed);
    if (event.success) {
      const value = event.data as WorkerEvent;
      this.emit("event", value);
      if (value.event === "app.ready") this.markReady();
      return;
    }

    const response = workerResponseSchema.safeParse(parsed);
    if (!response.success) {
      console.error("[mados-worker] received invalid protocol message");
      return;
    }

    const value = response.data;
    if (!value.id) return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    if (value.error) {
      const error = new Error(value.error.message);
      Object.assign(error, { code: value.error.code, details: value.error.details } satisfies Partial<WorkerError>);
      pending.reject(error);
    } else {
      pending.resolve(value.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function workerSpec(): { command: string; args: string[]; cwd: string } {
  const configured = process.env.MADOS_WORKER_PATH;
  if (configured) {
    return { command: configured, args: ["--worker"], cwd: dirname(configured) };
  }

  if (process.resourcesPath && !process.defaultApp) {
    const rid = workerRid();
    const packagedRoot = resolve(process.resourcesPath, "worker", rid);
    const executable = process.platform === "win32" ? resolve(packagedRoot, "Mados.Worker.exe") : resolve(packagedRoot, "Mados.Worker");
    const dll = resolve(packagedRoot, "Mados.Worker.dll");
    if (existsSync(executable)) return { command: executable, args: ["--worker"], cwd: packagedRoot };
    if (existsSync(dll)) return { command: "dotnet", args: [dll, "--worker"], cwd: packagedRoot };
    throw new Error(`Packaged Mados worker is missing for ${rid}`);
  }

  const projectRoot = resolve(__dirname, "../../..");
  const debugDll = resolve(projectRoot, "Mados.Worker/bin/Debug/net10.0/Mados.Worker.dll");
  if (existsSync(debugDll)) {
    return { command: "dotnet", args: [debugDll, "--worker"], cwd: projectRoot };
  }

  const project = resolve(projectRoot, "Mados.Worker/Mados.Worker.csproj");
  return { command: "dotnet", args: ["run", "--project", project, "--configuration", "Debug", "--", "--worker"], cwd: projectRoot };
}

function workerRid(): string {
  const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "osx" : "linux";
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  return `${platform}-${architecture}`;
}
