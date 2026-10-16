import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { LauncherUpdates } from "./launcher-updates";

function setup(packaged=true) {
  const updater=Object.assign(new EventEmitter(),{
    autoDownload:false, autoInstallOnAppQuit:true, allowPrerelease:true, allowDowngrade:true,
    checkForUpdates:vi.fn(async()=>{updater.emit("update-not-available");return null;}),
    downloadUpdate:vi.fn(async()=>["update.exe"]), quitAndInstall:vi.fn(),
  });
  const publish=vi.fn(); const service=new LauncherUpdates(updater,publish,{packaged,currentVersion:"0.40.3"});
  return {updater,publish,service};
}
afterEach(()=>vi.useRealTimers());

it("preserves release notes through download progress and clears stale release data after a fresh check",()=>{
 const {updater,service}=setup();service.start();
 updater.emit("update-available",{version:"0.42.0",releaseNotes:"## Изменения\n- Новое чтение новостей",releaseDate:"2026-10-15T18:00:00Z"});
 updater.emit("download-progress",{percent:24,transferred:1200,total:5000,bytesPerSecond:600});
 expect(service.snapshot()).toMatchObject({releaseNotes:"## Изменения\n- Новое чтение новостей",releaseDate:"2026-10-15T18:00:00.000Z",transferred:1200,total:5000,bytesPerSecond:600});
 updater.emit("update-downloaded",{version:"0.42.0"});expect(service.snapshot().releaseNotes).toContain("Изменения");
 updater.emit("update-not-available");expect(service.snapshot().releaseNotes).toBeUndefined();expect(service.snapshot().total).toBeUndefined();
 service.stop();
});

it("checks on startup and hourly without installing during ordinary app exit", async()=>{
  vi.useFakeTimers(); const {updater,service}=setup(); service.start();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  expect(updater.autoDownload).toBe(false); expect(updater.autoInstallOnAppQuit).toBe(false);
  expect(updater.allowPrerelease).toBe(false); expect(updater.allowDowngrade).toBe(false);
  expect(updater.quitAndInstall).not.toHaveBeenCalled(); service.stop();
  await vi.advanceTimersByTimeAsync(3_600_000); expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
});
it("keeps downloaded state for late renderers and only installs a ready update", async()=>{
  const {updater,service}=setup(); service.start();
  expect(service.install()).toBe(false);
  updater.emit("update-available",{version:"0.41.0"});
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
  await service.download(); expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  updater.emit("download-progress",{percent:44});
  expect(service.snapshot()).toMatchObject({status:"downloading",percent:44,version:"0.41.0"});
  updater.emit("update-downloaded",{version:"0.41.0"});
  expect(service.snapshot()).toMatchObject({status:"downloaded",version:"0.41.0"});
  await service.check(); expect(updater.checkForUpdates).not.toHaveBeenCalled();
  expect(service.install()).toBe(true); expect(updater.quitAndInstall).toHaveBeenCalledWith(true,true);
  service.stop();
});
it("coalesces repeated checks and catches background download failures",async()=>{
  const {updater,service}=setup(); service.start();
  let complete!:()=>void;
  updater.checkForUpdates.mockImplementationOnce(()=>new Promise(resolve=>{complete=()=>resolve({downloadPromise:Promise.reject(Error("network token=secret"))} as never);}));
  const first=service.check(), second=service.check(); complete(); await Promise.all([first,second]); await Promise.resolve();
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(service.snapshot().status).toBe("error"); expect(service.snapshot().message).not.toContain("secret");
  await service.check(); expect(service.snapshot().status).toBe("idle"); service.stop();
});
it("does not check or install from development runs",async()=>{
  vi.useFakeTimers(); const {updater,service}=setup(false); service.start();
  await service.check(); await vi.advanceTimersByTimeAsync(3_610_000);
  expect(updater.checkForUpdates).not.toHaveBeenCalled(); expect(service.install()).toBe(false);
  expect(service.snapshot().status).toBe("disabled"); service.stop();
});
it("does not leave unsupported packaged formats checking forever",async()=>{
  const {updater,service}=setup();service.start();
  updater.checkForUpdates.mockImplementationOnce(async()=>null);
  await service.check();
  expect(service.snapshot()).toMatchObject({status:"disabled"});
  expect(service.snapshot().message).toContain("GitHub");service.stop();
});
