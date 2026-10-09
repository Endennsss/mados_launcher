import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { InstallerFailure, type DownloadProgress } from "../contracts/installer";

export type DownloadIntegrity = { sizeBytes: number; digest?: string };
function requireHttps(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url;
  } catch { /* converted to a safe user-facing error below */ }
  throw new InstallerFailure("DOWNLOAD_URL", "Скачивание разрешено только по HTTPS", false);
}

export async function downloadAsset(
  assetUrl: string, destination: string, signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void, fetchImpl: typeof fetch = fetch,
  integrity?: DownloadIntegrity,
): Promise<void> {
  let url = requireHttps(assetUrl);
  const origin = url.origin;
  let ownedFile = false;
  const timeout = AbortSignal.timeout(30 * 60 * 1000);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    if (signal.aborted) throw new Error("cancelled");
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetchImpl(url.toString(), { signal: combined, redirect: "manual", headers: { Accept: "application/octet-stream" } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5) throw new InstallerFailure("DOWNLOAD_REDIRECT", "GitHub вернул неверное перенаправление", true);
      url = requireHttps(new URL(location, url).toString());
      if (url.origin !== origin && !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname)) {
        throw new InstallerFailure("DOWNLOAD_URL", "GitHub перенаправил загрузку на неизвестный сервер", false);
      }
    }
    if (!response?.ok) throw new InstallerFailure("DOWNLOAD_HTTP", "Сервер сборки вернул HTTP " + response?.status, true);
    if (!response.body) throw new InstallerFailure("DOWNLOAD_EMPTY", "Сервер не вернул содержимое ZIP", true);
    const header = Number(response.headers.get("content-length"));
    const totalBytes = integrity?.sizeBytes ?? (Number.isSafeInteger(header) && header > 0 ? header : null);
    let receivedBytes = 0;
    const hash = createHash("sha256");
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > (totalBytes ?? 2 * 1024 ** 3)) { callback(new InstallerFailure("DOWNLOAD_SIZE", "Размер загрузки не соответствует релизу", true)); return; }
        hash.update(chunk);
        onProgress({ receivedBytes, totalBytes, percent: totalBytes ? Math.floor(receivedBytes / totalBytes * 100) : null });
        callback(null, chunk);
      },
    });
    await mkdir(dirname(destination), { recursive: true });
    const output = createWriteStream(destination, { flags: "wx" });
    output.once("open", () => { ownedFile = true; });
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), counter, output, { signal: combined });
    if (!receivedBytes || totalBytes !== null && receivedBytes !== totalBytes) {
      throw new InstallerFailure("DOWNLOAD_SIZE", "Загрузка оборвалась: размер ZIP не совпадает с релизом", true);
    }
    if (integrity?.digest && "sha256:" + hash.digest("hex") !== integrity.digest) {
      throw new InstallerFailure("DOWNLOAD_DIGEST", "Проверка SHA-256 не пройдена. Скачайте ZIP повторно.", true);
    }
  } catch (error) {
    if (ownedFile) await rm(destination, { force: true });
    if (signal.aborted) throw new InstallerFailure("DOWNLOAD_CANCELLED", "Установка отменена", true);
    if (error instanceof InstallerFailure) throw error;
    if (timeout.aborted) throw new InstallerFailure("DOWNLOAD_TIMEOUT", "Загрузка заняла слишком много времени. Повторите попытку.", true);
    throw new InstallerFailure("DOWNLOAD_NETWORK", "Не удалось скачать или сохранить ZIP. Проверьте сеть, доступ к папке и свободное место.", true);
  }
}

