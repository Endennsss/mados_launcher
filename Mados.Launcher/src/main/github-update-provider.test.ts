import { describe, expect, it } from "vitest";
import { selectWindowsRelease } from "./github-update-provider";
import { GitHubWindowsUpdateProvider } from "./github-update-provider";
import type { AppUpdater } from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import { DigestTransform } from "builder-util-runtime";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const release = (arch = "x64") => ({
  tag_name: "v0.41.0", draft: false, prerelease: false, published_at: "2026-10-15T12:00:00Z",
  assets: [{ name: `Mados.Launcher.Windows.${arch}.exe`, size: 1234, digest: `sha256:${"a".repeat(64)}`,
    browser_download_url: `https://github.com/Endennsss/mados_launcher/releases/download/v0.41.0/Mados.Launcher.Windows.${arch}.exe` }],
});

it("passes a real SHA256 digest through the updater resolver and rejects damaged bytes",async()=>{
  const bytes=Buffer.from("installer fixture");
  const payload=release(process.arch); payload.assets[0].digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  class FixtureProvider extends GitHubWindowsUpdateProvider { protected async httpRequest() {return JSON.stringify(payload);} }
  const provider=new FixtureProvider({},{} as AppUpdater,{} as ProviderRuntimeOptions);
  const info=await provider.getLatestVersion();
  const file=provider.resolveFiles(info)[0];
  const digest=(file.info as unknown as {sha2:string}).sha2;
  expect(file.info.sha512).toBeUndefined(); expect(digest).toHaveLength(64);
  const verify=(body:Buffer)=>pipeline(Readable.from(body),new DigestTransform(digest,"sha256","hex"),new Writable({write(_chunk,_encoding,done){done();}}));
  await expect(verify(bytes)).resolves.toBeUndefined();
  await expect(verify(Buffer.from("corrupted"))).rejects.toThrow();
});
describe("GitHub Windows update selection", () => {
  it("selects the launcher installer for the exact architecture without latest.yml", () => {
    const payload = release(); payload.assets.push(...release("arm64").assets);
    const selected = selectWindowsRelease(payload, "arm64");
    expect(selected.version).toBe("0.41.0");
    expect(selected.asset.name).toBe("Mados.Launcher.Windows.arm64.exe");
    expect(selected.sha256).toBe("a".repeat(64));
  });
  it("rejects prereleases, missing architectures and missing checksums", () => {
    expect(() => selectWindowsRelease({...release(),prerelease:true}, "x64")).toThrow();
    expect(() => selectWindowsRelease(release(), "arm64")).toThrow();
    const payload = release(); payload.assets[0].digest = "";
    expect(() => selectWindowsRelease(payload,"x64")).toThrow();
  });
  it("rejects substituted assets, external URLs, credentials and query strings", () => {
    for (const url of ["https://evil.example/setup.exe", release().assets[0].browser_download_url + "?token=secret", release().assets[0].browser_download_url.replace("github.com", "user:pass@github.com"), release().assets[0].browser_download_url.replace("v0.41.0/", "v0.40.3/")]) {
      const payload=release(); payload.assets[0].browser_download_url=url;
      expect(() => selectWindowsRelease(payload,"x64")).toThrow();
    }
  });
});
