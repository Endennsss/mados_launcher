import { describe, expect, it, vi } from "vitest";
import { fetchLatestRelease } from "./release-client";

const release = (overrides: Record<string, unknown> = {}) => ({
  tag_name: "v0.40.3",
  name: "Mados Launcher 0.40.3",
  draft: false,
  prerelease: false,
  published_at: "2026-10-09T12:00:00Z",
  assets: [
    {
      name: "Mados.Launcher.Windows.x64.zip",
      size: 1234,
      browser_download_url: "https://github.com/Endennsss/mados_launcher/releases/download/v0.40.3/Mados.Launcher.Windows.x64.zip",
    },
    {
      name: "Mados.Launcher.Windows.x64.exe",
      size: 5678,
      browser_download_url: "https://github.com/Endennsss/mados_launcher/releases/download/v0.40.3/Mados.Launcher.Windows.x64.exe",
    },
  ],
  ...overrides,
});

describe("fetchLatestRelease", () => {
  it("selects the exact stable Windows x64 ZIP asset", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(release()), { status: 200, headers: { "content-type": "application/json" } }),
    );

    await expect(fetchLatestRelease(fetchImpl)).resolves.toEqual({
      tagName: "v0.40.3",
      version: "0.40.3",
      name: "Mados Launcher 0.40.3",
      publishedAt: "2026-10-09T12:00:00.000Z",
      sizeBytes: 1234,
      assetName: "Mados.Launcher.Windows.x64.zip",
      assetUrl: "https://github.com/Endennsss/mados_launcher/releases/download/v0.40.3/Mados.Launcher.Windows.x64.zip",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/Endennsss/mados_launcher/releases/latest",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/vnd.github+json" }) }),
    );
  });

  it.each([
    ["draft", { draft: true }],
    ["unknown stability", { draft: null, prerelease: null }],
    ["foreign URL", { assets: [{ name: "Mados.Launcher.Windows.x64.zip", size: 1, browser_download_url: "https://example.test/file.zip" }] }],
    ["prerelease", { prerelease: true }],
    ["missing asset", { assets: [] }],
    ["HTTP asset", { assets: [{ name: "Mados.Launcher.Windows.x64.zip", size: 1, browser_download_url: "http://example.test/file.zip" }] }],
  ])("rejects a %s release response", async (_label, overrides) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(release(overrides)), { status: 200 }));

    await expect(fetchLatestRelease(fetchImpl)).rejects.toMatchObject({ code: "RELEASE_INVALID" });
  });
});
