// Run against a self-contained worker; uses isolated data, never real accounts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { createServer } from "node:http";

const executable = resolve(process.argv[2] ?? "staging/worker/win-x64/Mados.Worker.exe");
const data = await mkdtemp(join(tmpdir(), "mados-catalog-smoke-"));
await mkdir(join(data, "cache"), { recursive: true });
await writeFile(join(data, "migration-v1.json"), JSON.stringify({
  Version: 1, CreatedAt: new Date().toISOString(), AppVersion: "smoke",
  LegacyUser: null, LegacyLocal: null, Backup: null,
  CacheUser: join(data, "cache-user"), CacheLocal: join(data, "cache"),
}));
const child = spawn(executable, ["--worker"], {
  cwd: dirname(executable), windowsHide: true,
  env: { ...process.env, MADOS_DATA_DIR: data },
});
let sequence = 0;
const pending = new Map();
let resolveReady, rejectReady, resolveExit, resolveCatalog, resolveCompleted;
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
const exited = new Promise(resolve => { resolveExit = resolve; });
const catalog = new Promise(resolve => { resolveCatalog = resolve; });
const completed = new Promise(resolve => { resolveCompleted = resolve; });
let catalogEvents = 0;
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });
createInterface({ input: child.stdout }).on("line", line => {
  const value = JSON.parse(line);
  if (value.event === "app.ready") resolveReady();
  if (value.event === "app.error") rejectReady(new Error("Worker initialization failed"));
  if (value.event === "servers.updated" && value.data.servers.length > 0) resolveCatalog(value.data);
  if (value.event === "servers.updated") {
    catalogEvents += 1;
    if (value.data.refreshing === false) resolveCompleted(value.data);
  }
  if (pending.has(value.id)) {
    const { resolve, reject } = pending.get(value.id);
    pending.delete(value.id);
    value.error ? reject(new Error(value.error.code)) : resolve(value.result);
  }
});
child.on("error", rejectReady);
child.on("exit", code => {
  resolveExit(code);
  for (const { reject } of pending.values()) reject(new Error(`Worker exited: ${code}`));
});
function invoke(method, params = {}) {
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ v: 1, id, method, params }) + "\n");
  });
}
const deadline = setTimeout(() => child.kill(), 45000);
const slowServer = createServer((request, response) => {
  setTimeout(() => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url.startsWith("/api/")
      ? { desc: "Smoke server", links: [] }
      : { name: "Smoke server", players: 1, soft_max_players: 10, tags: [] }));
  }, 1200).unref();
});
await new Promise(resolve => slowServer.listen(0, "127.0.0.1", resolve));
try {
  await ready;
  const port = slowServer.address().port;
  const info = invoke("servers.info", { address: `ss14://127.0.0.1:${port}`, hubAddress: `http://127.0.0.1:${port}/` });
  info.catch(() => undefined);
  const infoStart = performance.now();
  await invoke("app.getVersion");
  const detailsResponsiveMs = Math.round(performance.now() - infoStart);
  assert.ok(detailsResponsiveMs < 500, `Server details block other IPC requests: ${detailsResponsiveMs} ms`);
  assert.equal((await info).description, "Smoke server");
  const start = performance.now();
  const first = invoke("servers.list");
  await invoke("app.getVersion");
  const responsiveMs = Math.round(performance.now() - start);
  assert.ok(responsiveMs < 2000, `Catalog blocks other IPC requests: ${responsiveMs} ms`);
  await first;
  const available = await catalog;
  const firstListMs = Math.round(performance.now() - start);
  const repeatStart = performance.now();
  const repeat = await invoke("servers.list");
  const repeatMs = Math.round(performance.now() - repeatStart);
  assert.ok(repeatMs < 500, `Cached catalog took ${repeatMs} ms`);
  assert.ok(repeat.servers.length >= available.servers.length);
  const final = await completed;
  const fullRefreshMs = Math.round(performance.now() - start);
  assert.ok(final.revision > available.revision, "No progressive completion event");
  const manual = await invoke("servers.refresh");
  assert.ok(manual.refreshing, "Manual refresh did not bypass cache");
  const shutdownStart = performance.now();
  await invoke("app.shutdown");
  assert.equal(await exited, 0);
  const shutdownMs = Math.round(performance.now() - shutdownStart);
  assert.ok(shutdownMs < 2000, `Shutdown waited for network requests: ${shutdownMs} ms`);
  console.log(JSON.stringify({ responsiveMs, detailsResponsiveMs, firstListMs, repeatMs, serverCount: repeat.servers.length,
    fullRefreshMs, measuredPings: final.servers.filter(s => s.pingMs != null).length,
    catalogEvents, shutdownMs, cleanShutdown: true }));
} finally {
  clearTimeout(deadline);
  if (child.exitCode === null) child.kill();
  slowServer.closeAllConnections();
  slowServer.close();
  await writeFile(join(data, "worker.log"), stderr);
}
