import { useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, Download, ExternalLink, LoaderCircle, PackageCheck, RefreshCw, RotateCw, ShieldCheck, X } from "lucide-react";
import type { ShellUpdateState } from "../contracts/launcher";
import { ReleaseText } from "./ReleaseText";
import { newsDate } from "./news-journal";

function bytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toLocaleString("ru-RU", {maximumFractionDigits:1})} КБ`;
  return `${(value / 1024 / 1024).toLocaleString("ru-RU", {maximumFractionDigits:1})} МБ`;
}

export function LauncherUpdateView({ update, expanded = false, launchBusy = false, onOpenDetails }: { update: ShellUpdateState; expanded?: boolean; launchBusy?: boolean; onOpenDetails?: () => void }) {
  const [dismissedVersion, setDismissedVersion] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const { status } = update;
  const percent = Number.isFinite(update.percent) ? Math.min(100, Math.max(0, update.percent!)) : 0;
  const execute = async (action: () => Promise<unknown>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); setLocalError(undefined);
    try { await action(); } catch { setLocalError("Не удалось выполнить действие. Повторите попытку."); } finally { pendingRef.current = false; setPending(false); }
  };
  const openExternal = (url: string) => {
    setLocalError(undefined);
    void window.mados.openExternal(url).catch(() => setLocalError("Не удалось открыть ссылку. Повторите попытку."));
  };
  if (!expanded && (["idle", "disabled", "checking"].includes(status) || (status === "available" && dismissedVersion === update.version))) return null;
  const busy = pending || status === "checking" || status === "downloading";
  const label = status === "available" ? `Доступна версия ${update.version}`
    : status === "downloading" ? `Скачиваем Mados ${update.version ?? ""} · ${Math.round(percent)}%`
    : status === "downloaded" ? `Mados ${update.version} готов к установке`
    : status === "checking" ? "Проверяем GitHub Releases…"
    : status === "error" ? update.message ?? "Не удалось получить обновление Mados"
    : status === "disabled" ? update.message ?? "Обновления доступны в собранном приложении"
    : update.checkedAt ? "Установлена последняя версия" : "Проверяем релизы при запуске и каждый час";
  const action = status === "available" ? <button className="primary-button compact-button" disabled={busy} onClick={() => void execute(() => window.mados.downloadUpdate())}><Download size={16} />Скачать</button>
    : status === "downloaded" ? <button className="primary-button compact-button" disabled={launchBusy || pending} data-tooltip={launchBusy ? "Сначала завершите игру или подключение" : undefined} onClick={() => void execute(async () => window.mados.installUpdate())}><RotateCw size={16} />Перезапустить и обновить</button>
    : status !== "disabled" && status !== "downloading" ? <button className="secondary-button compact-button" disabled={busy} onClick={() => void execute(() => window.mados.checkForUpdates())}><RefreshCw size={16} className={busy ? "spin" : ""} />{status === "error" ? "Повторить" : "Проверить"}</button> : null;
  const progress = <div className="launcher-update-progress" role="progressbar" aria-label="Скачивание обновления Mados" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{width:`${percent}%`}}/></div>;
  if (expanded) return <section className={`settings-group launcher-update-panel update-studio state-${status}`} aria-label="Обновления Mados Launcher">
    <header className="update-studio-heading"><div><p className="eyebrow">Mados Launcher</p><h2>Обновления</h2><p>Улучшения, которые делают каждую смену удобнее.</p></div><span className="update-channel"><ShieldCheck size={14}/> Stable</span></header>
    <div className="update-overview"><span key={status} className={`update-symbol ${status}`}>
      {status === "checking" || status === "downloading" ? <LoaderCircle className="spin" size={28}/> : status === "error" ? <AlertTriangle size={28}/> : status === "downloaded" ? <PackageCheck size={30}/> : <Download size={28}/>}
    </span><div className="update-overview-copy"><span className="update-status-label" role="status">{label}</span><p>{status === "downloaded" ? launchBusy ? "Завершите игру, чтобы применить обновление." : "Всё готово. Перезапустите Mados, когда вам удобно." : status === "downloading" ? "Можно продолжать пользоваться лаунчером." : "Вы решаете, когда скачать и установить новую версию."}</p></div></div>
    <div className="update-versions"><div><span>Установленная версия</span><strong>{update.currentVersion}</strong><small>На этом устройстве</small></div><ArrowRight size={18}/><div className={update.version ? "next-version" : ""}><span>{status === "downloaded" ? "Готова к установке" : "Новая версия"}</span><strong>{update.version || "—"}</strong><small>{update.releaseDate ? newsDate(update.releaseDate) : status === "idle" && update.checkedAt ? "Обновлений нет" : status === "checking" ? "Проверяем релизы…" : "Стабильные релизы GitHub"}</small></div></div>
    {status === "downloading" && <div className="update-download"><div className="update-transfer"><span>{update.transferred != null && update.total != null && update.total > 0 ? `${bytes(update.transferred)} из ${bytes(update.total)}` : "Получаем сборку с GitHub"}</span><strong>{Math.round(percent)}%</strong></div>{progress}{update.bytesPerSecond != null && update.bytesPerSecond > 0 && <small>{bytes(update.bytesPerSecond)}/с</small>}</div>}
    <div className="update-controls">{action}<span><ShieldCheck size={13}/> Скачивание только по кнопке</span></div>
    {localError && <p className="journal-feedback" role="alert"><AlertTriangle size={16}/>{localError}</p>}
    {update.version && <section className="update-release-notes"><header><h3>Что нового</h3><span>{update.version}</span></header>{update.releaseNotes?.trim() ? <ReleaseText text={update.releaseNotes} onOpenLink={openExternal}/> : <p className="update-notes-empty">Описание изменений не добавлено. Подробности доступны в истории версий.</p>}</section>}
    <footer className="update-studio-footer"><span>{update.checkedAt ? `Проверено ${newsDate(update.checkedAt)}` : "Проверяем при запуске и каждый час"}</span><button className="text-link" onClick={() => openExternal("https://github.com/Endennsss/mados_launcher/releases")}>История версий <ExternalLink size={13}/></button></footer>
  </section>;
  return <section className="connection-banner shell-update-banner" aria-label="Обновления Mados Launcher">
    {expanded && <div className="settings-group-title"><span className="settings-group-icon"><Download size={18} /></span><h2>Обновления Mados Launcher</h2></div>}
    <div className="launcher-update-body">
      {status === "downloading" || status === "checking" ? <LoaderCircle size={18} className="spin" /> : status === "error" ? <AlertTriangle size={18} /> : status === "downloaded" ? <Check size={18} /> : <Download size={18} />}
      <div className="launcher-update-copy"><strong aria-live="polite">{label}</strong>{expanded && <p>Версия {update.currentVersion}. Только стабильные релизы Mados: скачивание по кнопке, установка после вашего перезапуска.</p>}{launchBusy && status === "downloaded" && <p>Обновление можно установить после завершения игры.</p>}{localError && <p role="alert">{localError}</p>}</div>
      <div className="launcher-update-actions">{onOpenDetails && <button className="text-link" onClick={onOpenDetails}>Подробнее <ArrowRight size={13}/></button>}{action}{!expanded && status === "available" && <button className="icon-button" aria-label="Напомнить об обновлении позже" onClick={() => setDismissedVersion(update.version)}><X size={16} /></button>}</div>
    </div>
    {status === "downloading" && progress}
    {expanded && <button className="text-link launcher-update-release-link" onClick={() => void execute(() => window.mados.openExternal("https://github.com/Endennsss/mados_launcher/releases"))}>История версий на GitHub <ExternalLink size={14} /></button>}
  </section>;
}
