// Exercises the real worker protocol with an isolated, packaged test server.
// No user accounts, launcher settings or game content are read or modified.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');
const sandbox = await mkdtemp(join(tmpdir(), 'mados-tools-smoke-'));
const fixture = join(sandbox, 'fixture');
await mkdir(fixture);
await writeFile(join(fixture, 'Robust.Server.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>`);
await writeFile(join(fixture, 'Program.cs'), `
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
if (args.FirstOrDefault() == "--pack") { ZipFile.CreateFromDirectory(AppContext.BaseDirectory, args[1]); return; }
var config = File.ReadAllText("server_config.toml");
var port = int.Parse(Regex.Match(config, @"(?m)^port\\s*=\\s*(\\d+)").Groups[1].Value);
Console.WriteLine("fixture server starting");
Console.Error.WriteLine("token=fixture-secret");
var listener = new TcpListener(IPAddress.Loopback, port);
listener.Start();
_ = Task.Run(() => { while (Console.ReadLine() is { } line) if (line == "shutdown" || line == "quit") { Console.WriteLine("graceful fixture shutdown"); Environment.Exit(0); } Environment.Exit(0); });
while (true) {
  using var client = await listener.AcceptTcpClientAsync();
  using var stream = client.GetStream();
  var buffer = new byte[8192]; await stream.ReadAsync(buffer);
  var body = "{\\\"name\\\":\\\"Fixture\\\",\\\"players\\\":0,\\\"soft_max_players\\\":10}";
  var response = Encoding.UTF8.GetBytes("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: " + Encoding.UTF8.GetByteCount(body) + "\\r\\nConnection: close\\r\\n\\r\\n" + body);
  await stream.WriteAsync(response);
}
`);
const build = spawnSync('dotnet', ['build', fixture, '-o', join(fixture, 'out'), '-v:q'], { encoding: 'utf8', windowsHide: true });
assert.equal(build.status, 0, build.stdout + build.stderr);
const archive = join(sandbox, 'fixture.zip');
const pack = spawnSync('dotnet', [join(fixture, 'out/Robust.Server.dll'), '--pack', archive], { encoding: 'utf8', windowsHide: true });
assert.equal(pack.status, 0, pack.stderr);

const binary = process.env.MADOS_SMOKE_WORKER ?? join(root, 'Mados.Worker/bin/Debug/net10.0/Mados.Worker.dll');
const child = spawn(binary.endsWith('.dll') ? 'dotnet' : binary, binary.endsWith('.dll') ? [binary] : [], {
  cwd: root, windowsHide: true,
  env: { ...process.env, MADOS_DATA_DIR: join(sandbox, 'data'), MADOS_CACHE_LOCAL_DIR: join(sandbox, 'cache'), MADOS_CACHE_USER_DIR: join(sandbox, 'cache-user') },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const events = [];
const pending = new Map();
let errorLog = '';
let resolveReady;
let rejectReady;
const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
const readyTimer = setTimeout(() => rejectReady(new Error('worker startup timeout')), 60000);
const exit = new Promise(resolveExit => child.once('exit', resolveExit));
child.stderr.on('data', chunk => { errorLog += chunk; });
createInterface({ input: child.stdout }).on('line', line => {
  const payload = JSON.parse(line);
  if (payload.event) {
    events.push(payload);
    if (payload.event === 'app.ready') { clearTimeout(readyTimer); resolveReady(); }
    if (payload.event === 'app.error') rejectReady(new Error(payload.data.message));
  }
  if (payload.id && pending.has(payload.id)) {
    const { resolve: accept, reject, timer } = pending.get(payload.id);
    clearTimeout(timer); pending.delete(payload.id);
    if (payload.error) reject(Object.assign(new Error(payload.error.message), { code: payload.error.code }));
    else accept(payload.result);
  }
});
function rpc(method, params = {}) {
  const id = randomUUID();
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 65000);
    pending.set(id, { resolve: accept, reject, timer });
    child.stdin.write(JSON.stringify({ v: 1, id, method, params }) + '\n');
  });
}
let serverPid;
try {
  await ready;
  assert.deepEqual(await rpc('localServers.list'), []);
  await assert.rejects(rpc('tools.cdn.inspect', { sourceUrl: 'http://example.com/server.zip' }), { code: 'INVALID_SOURCE' });
  const imported = await rpc('tools.cdn.import', { operationId: randomUUID(), localPath: archive, profileName: 'Smoke station' });
  const id = imported.profile.id;
  assert.ok(id);
  assert.equal((await rpc('localServers.list'))[0].id, id);
  assert.equal((await rpc('localServers.getStatus', { id })).profileId, id);
  let config = await rpc('localServers.getConfig', { id });
  assert.equal(config.bindAddress, '127.0.0.1');
  assert.equal(typeof config.rawToml, 'string');
  const invalid = { ...config, rawToml: '[broken' };
  await assert.rejects(rpc('localServers.saveConfig', { id, mode: 'raw', config: invalid }), { code: 'INVALID_TOML' });
  config = await rpc('localServers.saveConfig', { id, mode: 'fields', config: { ...config, port: 23129, hostname: 'Smoke name', maxPlayers: 8 } });
  assert.equal(config.port, 23129);
  const raw = config.rawToml.replace(/port\s*=\s*23129/g, 'port = 23130');
  config = await rpc('localServers.saveConfig', { id, mode: 'raw', config: { ...config, rawToml: raw } });
  assert.equal(config.port, 23130, 'raw editing must override stale form values');
  const running = await rpc('localServers.start', { id });
  serverPid = running.pid;
  assert.equal(running.status, 'running');
  assert.match(running.address, /^ss14:\/\/127\.0\.0\.1:23130/);
  assert.ok(events.some(item => item.event === 'localServer.log' && item.data.line.includes('fixture server')));
  assert.ok(!JSON.stringify(events).includes('fixture-secret'));
  assert.equal((await rpc('localServers.stop', { id })).status, 'stopped');
  assert.throws(() => process.kill(serverPid, 0));
  await writeFile(join(imported.profile.dataPath, 'sentinel.txt'), 'preserved user data');
  await rpc('tools.cdn.import', { operationId: randomUUID(), profileId: id, localPath: archive });
  assert.equal(await readFile(join(imported.profile.dataPath, 'sentinel.txt'), 'utf8'), 'preserved user data');
  assert.equal((await rpc('localServers.getConfig', { id })).port, 23130);
  const backups = await rpc('localServers.backups', { id });
  assert.ok(backups.some(item => item.reason === 'manual-update'));
  await rpc('localServers.rollback', { id, backupId: backups.find(item => item.reason === 'manual-update').id });
  const logPath = (await rpc('localServers.openLog', { id })).path;
  await access(logPath);
  assert.ok(!(await readFile(logPath, 'utf8')).includes('fixture-secret'));
  serverPid = (await rpc('localServers.start', { id })).pid;
  await rpc('app.shutdown');
  await exit;
  assert.throws(() => process.kill(serverPid, 0), 'shutdown must stop the server process');
  console.log(JSON.stringify({ passed: true, worker: binary, evidence: sandbox, scenarios: ['real RPC', 'import ZIP', 'config modes', 'TOML rejection', 'status readiness', 'live logs', 'secret redaction', 'stop', 'manual update', 'data preservation', 'backups', 'rollback', 'shutdown process cleanup'] }, null, 2));
} catch (error) {
  console.error(error);
  await writeFile(join(sandbox, 'worker-errors.log'), errorLog);
  console.error(`Evidence: ${sandbox}`);
  process.exitCode = 1;
} finally {
  clearTimeout(readyTimer);
  for (const entry of pending.values()) clearTimeout(entry.timer);
  if (child.exitCode === null) {
    child.stdin.end();
    await Promise.race([exit, new Promise(resolveWait => setTimeout(resolveWait, 10000))]);
    if (child.exitCode === null) child.kill();
  }
}
