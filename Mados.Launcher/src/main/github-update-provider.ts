import { z } from "zod";
import type { AppUpdater, UpdateInfo } from "electron-updater";
import { Provider, resolveFiles, type ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";

export const RELEASE_API = "https://api.github.com/repos/Endennsss/mados_launcher/releases/latest";
export const RELEASES_URL = "https://github.com/Endennsss/mados_launcher/releases";
const assetSchema = z.object({ name: z.string(), size: z.number().int().positive(), browser_download_url: z.string().url(), digest: z.string().optional().nullable() });
const releaseSchema = z.object({
  tag_name: z.string().regex(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  draft: z.literal(false), prerelease: z.literal(false), published_at: z.string().datetime(), assets: z.array(assetSchema),
  body: z.string().nullable().optional(),
});

function assetUrl(url: string, tag: string, name: string): string {
  const expected = `https://github.com/Endennsss/mados_launcher/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  if (url !== expected) throw new Error("Релиз содержит неподтверждённый адрес обновления.");
  return url;
}

export function selectWindowsRelease(payload: unknown, arch: string) {
  if (arch !== "x64" && arch !== "arm64") throw new Error("Архитектура обновления не поддерживается.");
  const release = releaseSchema.parse(payload);
  const name = `Mados.Launcher.Windows.${arch}.exe`;
  const matches = release.assets.filter(asset => asset.name === name);
  if (matches.length !== 1) throw new Error("В релизе нет установщика для этой архитектуры.");
  const asset = matches[0];
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? "");
  if (!digest) throw new Error("GitHub не предоставил контрольную сумму обновления.");
  assetUrl(asset.browser_download_url, release.tag_name, name);
  const checksum = release.assets.find(item => item.name === `${name}.sha512`);
  if (checksum) assetUrl(checksum.browser_download_url, release.tag_name, checksum.name);
  return { version: release.tag_name.replace(/^v/, ""), asset, sha256: digest[1].toLowerCase(), checksum, publishedAt: release.published_at, releaseNotes: release.body?.slice(0,64000) };
}

/** GitHub's stable release is authoritative; Windows archives need no latest.yml. */
export class GitHubWindowsUpdateProvider extends Provider<UpdateInfo> {
  constructor(_configuration: unknown, _updater: AppUpdater, runtime: ProviderRuntimeOptions) { super({ ...runtime, isUseMultipleRangeRequest: false }); }

  async getLatestVersion(): Promise<UpdateInfo> {
    const raw = await this.httpRequest(new URL(RELEASE_API), { Accept: "application/vnd.github+json", "User-Agent": "Mados-Launcher", "X-GitHub-Api-Version": "2022-11-28" });
    if (!raw || raw.length > 2_000_000) throw new Error("Некорректный ответ GitHub Releases.");
    const selected = selectWindowsRelease(JSON.parse(raw), process.arch);
    let sha512: string | undefined;
    if (selected.checksum) {
      const checksum = (await this.httpRequest(new URL(selected.checksum.browser_download_url)))?.trim();
      if (!checksum || !/^[A-Za-z0-9+/]{86}==$/.test(checksum)) throw new Error("Некорректная контрольная сумма релиза.");
      sha512 = checksum;
    }
    // electron-updater supports GitHub's SHA256 via sha2 at runtime. Its legacy
    // type still requires sha512, so bridge that one field for older releases.
    // New releases publish SHA512 too, enabling its persistent download cache.
    return {
      version: selected.version, releaseDate: selected.publishedAt, releaseNotes: selected.releaseNotes, path: selected.asset.browser_download_url,
      sha512, files: [{ url: selected.asset.browser_download_url, size: selected.asset.size, sha2: selected.sha256, sha512 }],
    } as unknown as UpdateInfo;
  }

  resolveFiles(info: UpdateInfo) { return resolveFiles(info, new URL(RELEASES_URL + "/")); }
}
