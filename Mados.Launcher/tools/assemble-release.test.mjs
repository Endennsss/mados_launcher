import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { assembleRelease, mergeUpdateMetadata } from './assemble-release.mjs';

test('merge architecture metadata without dropping either ZIP or replacing the x64 fallback', () => {
  const metadata = arch => ({version: '0.41.0', path: `Mados.${arch}.zip`, sha512: arch,
    files: [{url: `Mados.${arch}.zip`, sha512: arch, size: 100}]});
  const merged = mergeUpdateMetadata([metadata('x64'), metadata('arm64')], '0.41.0');
  assert.deepEqual(merged.files.map(file => file.url), ['Mados.x64.zip', 'Mados.arm64.zip']);
  assert.equal(merged.path, 'Mados.x64.zip');
});

test('reject mismatched release versions and conflicting checksums', () => {
  const info = {version: '0.41.0', files: [{url: 'Mados.x64.zip', sha512: 'one', size: 100}]};
  assert.throws(() => mergeUpdateMetadata([info], '0.40.3'), /version/i);
  assert.throws(() => mergeUpdateMetadata([info, {...info, files: [{...info.files[0], sha512: 'two'}]}], '0.41.0'), /conflict/i);
  assert.throws(() => mergeUpdateMetadata([{version: '0.41.0', files: []}], '0.41.0'), /files/i);
});

test('assemble a complete release, validate actual hashes, and reject stale output or tampered files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mados-release-test-'));
  try {
    const input = join(root, 'input'); await mkdir(input);
    const names = ['Mados.Installer.Windows.x64.exe', 'Mados.Launcher.Linux.x86_64.AppImage', 'Mados.Launcher.Linux.arm64.AppImage'];
    for (const arch of ['x64', 'arm64']) {
      for (const platform of ['Windows', 'macOS', 'Linux']) names.push(`Mados.Launcher.${platform}.${arch}.zip`);
      names.push(`Mados.Launcher.Windows.${arch}.exe`, `Mados.Launcher.macOS.${arch}.dmg`);
    }
    const files = new Map();
    for (const name of names) {
      const bytes = Buffer.from(name);
      await writeFile(join(input, name), bytes);
      const sha512 = createHash('sha512').update(bytes).digest('base64');
      files.set(name, {url: name, sha512, size: bytes.length});
      if (/Windows\.(x64|arm64)\.exe$/.test(name)) await writeFile(join(input, `${name}.sha512`), sha512);
    }
    for (const [name, target] of [['latest.yml', 'Windows.x64.zip'], ['latest-mac.yml', 'macOS.x64.zip'],
      ['latest-linux.yml', 'Linux.x64.zip'], ['latest-linux-arm64.yml', 'Linux.arm64.zip']]) {
      await writeFile(join(input, name), yaml.dump({version: '0.41.0', files: [files.get(`Mados.Launcher.${target}`)]}));
    }
    const output = join(root, 'output');
    await assembleRelease(input, output, '0.41.0');
    assert.match(await readFile(join(output, 'SHA256SUMS.txt'), 'utf8'), /Mados.Installer.Windows.x64.exe/);
    await assert.rejects(assembleRelease(input, output, '0.41.0'), /exist/i);
    await writeFile(join(input, 'Mados.Launcher.Windows.x64.zip'), 'tampered');
    await assert.rejects(assembleRelease(input, join(root, 'broken'), '0.41.0'), /does not match artifact/i);
  } finally {
    assert.equal(dirname(root), tmpdir());
    await rm(root, {recursive: true, force: true});
  }
});
