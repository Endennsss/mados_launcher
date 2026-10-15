import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

export function mergeUpdateMetadata(documents, version) {
  const files = new Map();
  for (const document of documents) {
    if (document.version !== version) throw new Error('Update metadata version does not match release');
    if (!Array.isArray(document.files) || !document.files.length) throw new Error('Update metadata has no files');
    for (const file of document.files) {
      const prior = files.get(file.url);
      if (prior && (prior.sha512 !== file.sha512 || prior.size !== file.size)) throw new Error(`Conflicting metadata: ${file.url}`);
      files.set(file.url, file);
    }
  }
  return {...documents[0], files: [...files.values()]};
}

async function hashes(path) {
  const sha256 = createHash('sha256'), sha512 = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    sha256.update(chunk); sha512.update(chunk); size += chunk.length;
  }
  return {sha256: sha256.digest('hex'), sha512: sha512.digest('base64'), size};
}

export async function assembleRelease(source, destination, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable release version is required');
  const assets = new Map(), metadata = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) throw new Error(`Unexpected artifact: ${path}`);
      if (/^latest.*\.yml$/.test(entry.name)) {
        const documents = metadata.get(entry.name) ?? [];
        documents.push(yaml.load(await readFile(path, 'utf8')));
        metadata.set(entry.name, documents);
      } else if (entry.name.startsWith('Mados.')) {
        if (assets.has(entry.name)) throw new Error(`Duplicate release asset: ${entry.name}`);
        assets.set(entry.name, {path, ...await hashes(path)});
      }
    }
  }
  await visit(resolve(source));
  const required = ['Mados.Installer.Windows.x64.exe'];
  for (const platform of ['Windows', 'macOS', 'Linux']) {
    for (const arch of ['x64', 'arm64']) required.push(`Mados.Launcher.${platform}.${arch}.zip`);
  }
  for (const arch of ['x64', 'arm64']) {
    required.push(`Mados.Launcher.Windows.${arch}.exe`, `Mados.Launcher.Windows.${arch}.exe.sha512`, `Mados.Launcher.macOS.${arch}.dmg`);
  }
  required.push('Mados.Launcher.Linux.x86_64.AppImage', 'Mados.Launcher.Linux.arm64.AppImage');
  for (const name of required) if (!assets.has(name)) throw new Error(`Missing required release asset: ${name}`);
  for (const arch of ['x64', 'arm64']) {
    const name = `Mados.Launcher.Windows.${arch}.exe`;
    const expected = (await readFile(assets.get(`${name}.sha512`).path, 'utf8')).trim();
    if (assets.get(name).sha512 !== expected) throw new Error(`Invalid Windows updater checksum: ${name}`);
  }
  for (const name of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml']) {
    if (!metadata.has(name)) throw new Error(`Missing update metadata: ${name}`);
  }
  const merged = new Map();
  for (const [name, documents] of metadata) {
    const document = mergeUpdateMetadata(documents, version);
    for (const file of document.files) {
      const asset = assets.get(file.url);
      if (basename(file.url) !== file.url || !asset || asset.sha512 !== file.sha512 || asset.size !== file.size) {
        throw new Error(`Update metadata does not match artifact: ${file.url}`);
      }
    }
    merged.set(name, document);
  }
  // Refuse an existing output directory: stale files must never leak into a release.
  await mkdir(destination);
  for (const [name, asset] of assets) await copyFile(asset.path, join(destination, name), constants.COPYFILE_EXCL);
  for (const [name, document] of merged) await writeFile(join(destination, name), yaml.dump(document), {flag: 'wx'});
  const checksums = [];
  for (const name of (await readdir(destination)).sort()) checksums.push(`${(await hashes(join(destination, name))).sha256}  ${name}`);
  await writeFile(join(destination, 'SHA256SUMS.txt'), checksums.join('\n') + '\n', {flag: 'wx'});
  console.log(`Verified ${assets.size} assets and ${merged.size} update manifests for ${version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination, version] = process.argv.slice(2);
  if (!source || !destination || !version) throw new Error('Usage: assemble-release.mjs INPUT OUTPUT VERSION');
  await assembleRelease(source, destination, version);
}
