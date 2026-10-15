import { useState } from "react";
import { AlertTriangle, Check, Download, ExternalLink, LoaderCircle, RefreshCw, RotateCw, X } from "lucide-react";
import type { ShellUpdateState } from "../contracts/launcher";

export function LauncherUpdateView({ update, expanded = false, launchBusy = false }: { update: ShellUpdateState; expanded?: boolean; launchBusy?: boolean }) {
  const [dismissedVersion, setDismissedVersion] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const [pending, setPending] = useState(false);
  const { status } = update;
  const execute = async (action: () => Promise<unknown>) => {
    setPending(true); setLocalError(undefined);
    try { await action(); } catch { setLocalError("Не удалось выполнить действие. Повторите попытку."); } finally { setPending(false); }
  };
  if (!expanded && (["idle", "disabled", "checking"].includes(status) || (status === "available" && dismissedVersion === update.version))) return null;
  const busy = pending || status === "checking" || status === "downloading";
  const label = status === "available" ? `Доступна версия ${update.version}`
    : status === "downloading" ? `Скачиваем Mados ${update.version ?? ""} · ${Math.round(update.percent ?? 0)}%`
    : status === "downloaded" ? `Mados ${update.version} готов к установке`
    : status === "checking" ? "Проверяем GitHub Releases…"
    : status === "error" ? update.message ?? "Не удалось получить обновление Mados"
    : status === "disabled" ? update.message ?? "Обновления доступны в собранном приложении"
    : update.checkedAt ? "Установлена последняя версия" : "Проверяем релизы при запуске и каждый час";
  const action = status === "available" ? <button className="primary-button compact-button" disabled={busy} onClick={() => void execute(() => window.mados.downloadUpdate())}><Download size={16} />Скачать</button>
    : status === "downloaded" ? <button className="primary-button compact-button" disabled={launchBusy} data-tooltip={launchBusy ? "Сначала завершите игру или подключение" : undefined} onClick={() => window.mados.installUpdate()}><RotateCw size={16} />Перезапустить и обновить</button>
    : status !== "disabled" && status !== "downloading" ? <button className="secondary-button compact-button" disabled={busy} onClick={() => void execute(() => window.mados.checkForUpdates())}><RefreshCw size={16} className={busy ? "spin" : ""} />{status === "error" ? "Повторить" : "Проверить"}</button> : null;
  return <section className={expanded ? "settings-group launcher-update-panel" : "connection-banner shell-update-banner"} aria-label="Обновления Mados Launcher">
    {expanded && <div className="settings-group-title"><span className="settings-group-icon"><Download size={18} /></span><h2>Обновления Mados Launcher</h2></div>}
    <div className="launcher-update-body">
      {status === "downloading" || status === "checking" ? <LoaderCircle size={18} className="spin" /> : status === "error" ? <AlertTriangle size={18} /> : status === "downloaded" ? <Check size={18} /> : <Download size={18} />}
      <div className="launcher-update-copy"><strong aria-live="polite">{label}</strong>{expanded && <p>Версия {update.currentVersion}. Только стабильные релизы Mados: скачивание по кнопке, установка после вашего перезапуска.</p>}{launchBusy && status === "downloaded" && <p>Обновление можно установить после завершения игры.</p>}{localError && <p role="alert">{localError}</p>}</div>
      <div className="launcher-update-actions">{action}{!expanded && status === "available" && <button className="icon-button" aria-label="Напомнить об обновлении позже" onClick={() => setDismissedVersion(update.version)}><X size={16} /></button>}</div>
    </div>
    {status === "downloading" && <div className="launcher-update-progress" role="progressbar" aria-label="Скачивание обновления Mados" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(update.percent ?? 0)}><span style={{ width: `${update.percent ?? 0}%` }} /></div>}
    {expanded && <button className="text-link launcher-update-release-link" onClick={() => void execute(() => window.mados.openExternal("https://github.com/Endennsss/mados_launcher/releases"))}>История версий на GitHub <ExternalLink size={14} /></button>}
  </section>;
}
