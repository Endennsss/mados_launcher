// Real stdio/SQLite regression: run a worker without a Windows console, like Electron.
// Only an isolated data directory and a local HTTP fixture are used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const executable = resolve(process.argv[2] ?? "staging/worker/win-x64/Mados.Worker.exe");
const data = await mkdtemp(join(tmpdir(), "mados-unicode-smoke-"));
await writeFile(join(data, "migration-v1.json"), JSON.stringify({
  Version: 1, CreatedAt: new Date().toISOString(), AppVersion: "smoke",
  LegacyUser: null, LegacyLocal: null, Backup: null,
  CacheUser: join(data, "cache-user"), CacheLocal: join(data, "cache"),
}));
const name = "🐟 РЫБЬЯ СТАНЦИЯ: ПЕРСЕЙ | Помощь новичкам — 東京";
let hubAvailable = true;
let descriptionAvailable = true;
let hubRequiresSlash = false;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  const hubMiss = request.url.startsWith("/api/") && (!hubAvailable || (hubRequiresSlash && !new URL(request.url, "http://localhost").searchParams.get("url")?.endsWith("/")));
  if (request.url === "/connect/info" || hubMiss || (request.url.endsWith("/info") && !descriptionAvailable)) {
    response.writeHead(404); response.end("{}"); return;
  }
  response.end(JSON.stringify(request.url.startsWith("/api/") || request.url.endsWith("/info")
    ? { desc: "Русское описание", links: [] }
    : { name, players: 29, soft_max_players: 140, map: "Marathon", preset: "Рассказчик: Безумный", tags: ["lang:ru", "rp:low"] }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = `ss14://127.0.0.1:${server.address().port}`;
let active;
function start() {
  const child = active = spawn(executable, ["--worker"], {
    cwd: dirname(executable), windowsHide: true, detached: process.platform === "win32",
    env: { ...process.env, MADOS_DATA_DIR: data }, stdio: ["pipe", "pipe", "pipe"],
  });
  let sequence = 0, stderr = "", readyResolve, readyReject;
  const pending = new Map(), events = [];
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise(resolve => child.on("exit", resolve));
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("error", readyReject);
  child.stdin.on("error", error => { for (const p of pending.values()) p.reject(error); });
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    if (message.event) events.push(message);
    if (message.event === "app.ready") readyResolve();
    if (message.event === "app.error") readyReject(new Error(message.data.message));
    const p = pending.get(message.id);
    if (p) { pending.delete(message.id); message.error ? p.reject(new Error(message.error.code)) : p.resolve(message.result); }
  });
  child.on("exit", code => {
    for (const p of pending.values()) p.reject(new Error(`Worker exited: ${code}`));
    readyReject(new Error(`Worker exited before ready: ${code}`));
  });
  return { ready, events, invoke(method, params = {}) {
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ v: 1, id, method, params }) + "\n", "utf8");
    });
  }, async stop() {
    await this.invoke("app.shutdown");
    assert.equal(await exited, 0);
    await writeFile(join(data, "worker.log"), stderr);
    active = null;
  } };
}
const deadline = setTimeout(() => { active?.kill(); server.closeAllConnections(); server.close(); process.exitCode = 1; }, 45_000);
try {
  let worker = start();
  await worker.ready;
  const favorites = await worker.invoke("favorites.add", { address, name });
  assert.equal(favorites[0].name, name, "UTF-8 must survive renderer → worker → response");
  const started = await worker.invoke("servers.connect", { address: `${address}/connect`, name });
  assert.equal(started.name, name, "Connection name must not become OEM mojibake");
  assert.equal(worker.events.find(e => e.event === "connection.started").data.name, name);
  const info = await worker.invoke("servers.info", { address, hubAddress: `http://127.0.0.1:${server.address().port}/` });
  assert.equal(info.name, name);
  assert.equal(info.description, "Русское описание");
  assert.equal(info.map, "Marathon");
  assert.equal(info.mode, "Рассказчик: Безумный");
  hubAvailable = false;
  const direct = await worker.invoke("servers.info", { address, hubAddress: `http://127.0.0.1:${server.address().port}/` });
  assert.equal(direct.description, "Русское описание", "A missing hub entry must fall back to the server itself");
  assert.equal(direct.name, name);
  descriptionAvailable = false;
  const statusOnly = await worker.invoke("servers.info", { address, hubAddress: `http://127.0.0.1:${server.address().port}/` });
  assert.equal(statusOnly.status, "online", "Missing description must not hide a successful status");
  assert.equal(statusOnly.map, "Marathon");
  assert.equal(statusOnly.mode, "Рассказчик: Безумный");
  hubAvailable = true; hubRequiresSlash = true;
  const hubFallback = await worker.invoke("servers.info", { address: `${address}/station/`, hubAddress: `http://127.0.0.1:${server.address().port}/` });
  assert.equal(hubFallback.description, "Русское описание", "Hub fallback must preserve slash-sensitive server identities");
  await worker.stop();
  const account = "11111111-1111-1111-1111-111111111111";
  const otherAccount = "22222222-2222-2222-2222-222222222222";
  const settings = new DatabaseSync(join(data, "settings.db"));
  settings.prepare("INSERT INTO Login VALUES(?,?,?,?)").run(account, "Smoke", "expired-test-placeholder", "2000-01-01 00:00:00+00:00");
  settings.prepare("INSERT OR REPLACE INTO Config(Key,Value) VALUES('SelectedLogin',?)").run(account);
  settings.close();
  const history = new DatabaseSync(join(data, "recent-connections.db"));
  const recorded = "2026-10-18T12:00:00.0000000+00:00";
  for (const id of [account, otherAccount]) history.prepare("INSERT INTO RecentConnection VALUES(?,?,?,?,?,?)").run(id, address, "Р Р«Р‘Р¬РЇ", recorded, 7, 123);
  history.close();
  worker = start();
  await worker.ready;
  assert.equal((await worker.invoke("app.getState")).favorites[0].name, name, "Saved Unicode must survive worker restart");
  await worker.invoke("servers.info", { address, hubAddress: `http://127.0.0.1:${server.address().port}/` });
  const recent = (await worker.invoke("recentConnections.list"))[0];
  assert.equal(recent.name, name, "Refresh must replace a damaged saved recent name with the authoritative name");
  assert.equal(recent.playerCount, 7);
  assert.equal(recent.pingMs, 123);
  assert.equal(Date.parse(recent.lastConnectedAt), Date.parse(recorded));
  if (process.argv.includes("--live")) {
    const live = await worker.invoke("servers.info", { address: "ss14s://server.ss14.org/perseus" });
    assert.equal(live.status, "online");
    assert.match(live.name, /РЫБЬЯ СТАНЦИЯ/);
    assert.ok(live.map && live.mode, "Fish Station must expose current map/preset through the real worker");
    console.log(JSON.stringify({ live: true, name: live.name, map: live.map, mode: live.mode, players: live.playerCount }));
  }
  await worker.stop();
  const saved = new DatabaseSync(join(data, "recent-connections.db"));
  assert.equal(saved.prepare("SELECT Name FROM RecentConnection WHERE AccountId=?").get(otherAccount).Name, "Р Р«Р‘Р¬РЇ", "Refresh must not change another account's history");
  assert.equal(saved.prepare("SELECT Name FROM RecentConnection WHERE AccountId=?").get(account).Name, name);
  saved.close();
  console.log(JSON.stringify({ passed: true, data, checks: ["UTF-8 stdio", "connection event", "persist/restart", "public map/preset fields", "hub 404 fallback", "status without description", "saved name refresh without changing history or other accounts"] }));
} finally {
  clearTimeout(deadline);
  if (active?.exitCode === null) active.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
