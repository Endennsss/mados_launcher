import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import { InstallerFailure, type InstallerStage } from "../contracts/installer";

const MAX_UNCOMPRESSED_BYTES = 4 * 1024 ** 3;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function validateArchiveEntry(entryName: string, isSymlink: boolean): string {
  if (isSymlink) throw new InstallerFailure("ZIP_SYMLINK", "Архив содержит символическую ссылку", false);
  const name = entryName.replaceAll("\\", "/");
  const segments = name.replace(/\/$/, "").split("/");
  if (!name || name.startsWith("/") || segments.some((part) =>
    !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || RESERVED.test(part)
  )) throw new InstallerFailure("ZIP_PATH", "Архив содержит небезопасный путь", false);
  return segments.join("/");
}

function openArchive(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => yauzl.open(path, {
    lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true,
  }, (error, zip) => error ? reject(error) : resolve(zip!)));
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InstallerFailure("DOWNLOAD_CANCELLED", "Установка отменена", true);
}

async function listEntries(zip: yauzl.ZipFile, signal?: AbortSignal): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    const names = new Map<string, string>();
    let total = 0;
    const abort = () => reject(new InstallerFailure("DOWNLOAD_CANCELLED", "Установка отменена", true));
    const cleanup = () => { zip.removeListener("entry", entry); zip.removeListener("error", reject); signal?.removeEventListener("abort", abort); };
    const entry = (value: yauzl.Entry) => {
      try {
        cancelled(signal);
        const mode = value.externalFileAttributes >>> 16;
        const name = validateArchiveEntry(value.fileName, (mode & 0xf000) === 0xa000);
        const key = name.toLowerCase();
        if (names.has(key) || (value.generalPurposeBitFlag & 1) !== 0 || entries.length >= 50000) {
          throw new InstallerFailure("ZIP_INVALID", "Архив содержит повторяющиеся, зашифрованные или слишком многочисленные файлы", false);
        }
        total += value.uncompressedSize;
        if (total > MAX_UNCOMPRESSED_BYTES) throw new InstallerFailure("ZIP_SIZE", "Распакованная сборка превышает допустимый размер", false);
        names.set(key, value.fileName);
        entries.push(value);
        zip.readEntry();
      } catch (error) { cleanup(); reject(error); }
    };
    signal?.addEventListener("abort", abort, { once: true });
    zip.on("entry", entry);
    zip.once("error", reject);
    zip.once("end", () => { cleanup(); resolve(entries); });
    zip.readEntry();
  });
}

export async function extractArchive(
  zipPath: string, stagingPath: string, onStage: (stage: InstallerStage) => void, signal?: AbortSignal,
): Promise<string> {
  cancelled(signal);
  onStage("extracting");
  // Must be a new directory owned by this operation. Never delete existing paths.
  await mkdir(stagingPath);
  let zip: yauzl.ZipFile | null = null;
  try {
    zip = await openArchive(zipPath);
    const entries = await listEntries(zip, signal);
    for (const entry of entries) {
      cancelled(signal);
      const name = validateArchiveEntry(entry.fileName, false);
      const target = join(stagingPath, name);
      if (entry.fileName.endsWith("/")) { await mkdir(target, { recursive: true }); continue; }
      await mkdir(dirname(target), { recursive: true });
      const input = await new Promise<Readable>((resolve, reject) =>
        zip!.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream!)));
      let checksum = 0;
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) { checksum = crc32(chunk, checksum); callback(null, chunk); },
        flush(callback) { callback(checksum === entry.crc32 ? null : new InstallerFailure("ZIP_CRC", "ZIP повреждён. Скачайте сборку повторно.", true)); },
      });
      await pipeline(input, verify, createWriteStream(target, { flags: "wx" }), { signal });
    }
    const executable = join(stagingPath, "Mados Launcher.exe");
    if (!(await stat(executable).catch(() => null))?.isFile()) {
      throw new InstallerFailure("INSTALL_EXECUTABLE", "В ZIP не найден Mados Launcher.exe", false);
    }
    return executable;
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    cancelled(signal);
    if (error instanceof InstallerFailure) throw error;
    throw new InstallerFailure("ZIP_INVALID", "Не удалось проверить или распаковать ZIP-сборку", true);
  } finally { zip?.close(); }
}

