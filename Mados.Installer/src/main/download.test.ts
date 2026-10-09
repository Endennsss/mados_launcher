import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAsset } from "./download";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function responseFromChunks(chunks: Uint8Array[], contentLength?: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: contentLength === undefined ? undefined : { "content-length": String(contentLength) },
  });
}

describe("downloadAsset", () => {
  it("rejects a truncated response and removes its partial ZIP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mados-installer-download-"));
    tempDirectories.push(directory);
    const destination = join(directory, "release.zip");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(responseFromChunks([new TextEncoder().encode("abc")], 10));
    await expect(downloadAsset("https://example.test/release.zip", destination, new AbortController().signal, () => undefined, fetchImpl)).rejects.toMatchObject({ code: "DOWNLOAD_SIZE" });
    await expect(readFile(destination)).rejects.toThrow();
  });
  it("streams the ZIP to disk and reports byte progress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mados-installer-download-"));
    tempDirectories.push(directory);
    const destination = join(directory, "release.zip");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(responseFromChunks([new TextEncoder().encode("abc"), new TextEncoder().encode("def")], 6));
    const progress: Array<{ receivedBytes: number; totalBytes: number | null; percent: number | null }> = [];

    await downloadAsset("https://example.test/release.zip", destination, new AbortController().signal, (value) => progress.push(value), fetchImpl);

    expect(new TextDecoder().decode(await readFile(destination))).toBe("abcdef");
    expect(progress.at(-1)).toEqual({ receivedBytes: 6, totalBytes: 6, percent: 100 });
  });

  it("reports an unknown percentage when content length is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mados-installer-download-"));
    tempDirectories.push(directory);
    const progress: Array<{ receivedBytes: number; totalBytes: number | null; percent: number | null }> = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(responseFromChunks([new TextEncoder().encode("abc")]))

    await downloadAsset("https://example.test/release.zip", join(directory, "release.zip"), new AbortController().signal, (value) => progress.push(value), fetchImpl);

    expect(progress.at(-1)).toEqual({ receivedBytes: 3, totalBytes: null, percent: null });
  });

  it("rejects non-success responses and removes a partial destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mados-installer-download-"));
    tempDirectories.push(directory);
    const destination = join(directory, "release.zip");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("nope", { status: 503 }));

    await expect(downloadAsset("https://example.test/release.zip", destination, new AbortController().signal, () => undefined, fetchImpl)).rejects.toMatchObject({ code: "DOWNLOAD_HTTP" });
    await expect(readFile(destination)).rejects.toThrow();
  });

  it("rejects insecure URLs before calling fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(downloadAsset("http://example.test/release.zip", "release.zip", new AbortController().signal, () => undefined, fetchImpl)).rejects.toMatchObject({ code: "DOWNLOAD_URL" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("removes the destination when the caller aborts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mados-installer-download-"));
    tempDirectories.push(directory);
    const destination = join(directory, "release.zip");
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Aborted", "AbortError"));

    await expect(downloadAsset("https://example.test/release.zip", destination, controller.signal, () => undefined, fetchImpl)).rejects.toMatchObject({ code: "DOWNLOAD_CANCELLED" });
    await expect(readFile(destination)).rejects.toThrow();
  });
});
