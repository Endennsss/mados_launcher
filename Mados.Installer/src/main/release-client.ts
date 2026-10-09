import { InstallerFailure, type ReleaseInfo } from "../contracts/installer";

const RELEASE_API_URL = "https://api.github.com/repos/Endennsss/mados_launcher/releases/latest";
const ASSET_NAME = "Mados.Launcher.Windows.x64.zip";
const USER_AGENT = "Mados-Installer/0.40.3";

type GithubAsset = {
  name?: unknown;
  size?: unknown;
  browser_download_url?: unknown;
};

type GithubRelease = {
  tag_name?: unknown;
  name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function requireHttps(value: unknown, code: string): string {
  if (typeof value !== "string") throw new InstallerFailure(code, "GitHub returned an invalid URL", false);
  try {
    if (new URL(value).protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new InstallerFailure(code, "GitHub returned an insecure download URL", false);
  }
  return value;
}

export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ReleaseInfo> {
  let response: Response;
  try {
    response = await fetchImpl(RELEASE_API_URL, {
      signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]),
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
      },
    });
  } catch {
    throw new InstallerFailure("RELEASE_NETWORK", "Не удалось связаться с GitHub Releases", true);
  }

  if (!response.ok) {
    throw new InstallerFailure("RELEASE_HTTP", `GitHub вернул HTTP ${response.status}`, response.status >= 500 || response.status === 429);
  }

  let payload: GithubRelease;
  try {
    payload = asObject(await response.json()) as GithubRelease;
  } catch {
    throw new InstallerFailure("RELEASE_INVALID", "GitHub вернул повреждённые данные релиза", false);
  }

  if (payload.draft !== false || payload.prerelease !== false) {
    throw new InstallerFailure("RELEASE_INVALID", "Последний релиз является черновиком или пререлизом", false);
  }

  const tagName = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
  const publishedAt = typeof payload.published_at === "string" ? new Date(payload.published_at) : null;
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const asset = assets.map(asObject).find((candidate) => candidate.name === ASSET_NAME);
  const sizeBytes = asset?.size;
  const assetUrl = asset?.browser_download_url;

  if (!tagName || !publishedAt || Number.isNaN(publishedAt.getTime()) || !asset || typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new InstallerFailure("RELEASE_INVALID", "В релизе отсутствует корректная ZIP-сборка Mados Launcher", false);
  }

  return {
    tagName,
    version: tagName.replace(/^v/i, ""),
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : `Mados Launcher ${tagName}`,
    publishedAt: publishedAt.toISOString(),
    sizeBytes,
    assetName: ASSET_NAME,
    assetUrl: requireReleaseAssetUrl(assetUrl, tagName),
    ...(typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(asset.digest) ? { digest: asset.digest } : {}),
  };
}

function requireReleaseAssetUrl(value: unknown, tagName: string): string {
  const url = requireHttps(value, "RELEASE_INVALID");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new InstallerFailure("RELEASE_INVALID", "GitHub вернул некорректный URL сборки", false); }
  if (parsed.username || parsed.password || parsed.hostname !== "github.com" ||
      parsed.pathname !== `/Endennsss/mados_launcher/releases/download/${encodeURIComponent(tagName)}/${ASSET_NAME}` ||
      parsed.search || parsed.hash) {
    throw new InstallerFailure("RELEASE_INVALID", "Релиз содержит неподтверждённый URL сборки", false);
  }
  return parsed.toString();
}

