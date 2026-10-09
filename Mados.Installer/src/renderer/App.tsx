import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Download, ExternalLink, FolderOpen, LoaderCircle, PackageOpen, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { DownloadProgress, InstallerError, InstallerStage, ReleaseInfo } from "../contracts/installer";
import catLogo from "./assets/cat-logo.png";

const STAGE_LABELS: Record<InstallerStage, string> = {
  checking: "Проверяем последний релиз",
  ready: "Релиз готов к установке",
  downloading: "Скачиваем сборку",
  extracting: "Распаковываем файлы",
  installing: "Устанавливаем Mados Launcher",
  launching: "Запускаем лаунчер",
  completed: "Установка завершена",
  error: "Нужна повторная попытка",
};

const STAGES: InstallerStage[] = ["checking", "downloading", "extracting", "installing", "launching", "completed"];

function formatBytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} КБ`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1).replace(".0", "")} МБ`;
  return `${(value / 1024 ** 3).toFixed(1)} ГБ`;
}

function getError(error: unknown): InstallerError {
  if (typeof error === "object" && error !== null) {
    const value = error as Partial<InstallerError>;
    if (typeof value.message === "string") return { code: value.code ?? "INSTALLER_ERROR", message: value.message, retryable: value.retryable !== false };
  }
  return { code: "INSTALLER_ERROR", message: "Не удалось продолжить установку", retryable: true };
}

function stageIndex(stage: InstallerStage): number {
  const index = STAGES.indexOf(stage);
  return index < 0 ? 0 : index;
}

export default function App(): JSX.Element {
  const api = window.madosInstaller;
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [directory, setDirectory] = useState("");
  const [stage, setStage] = useState<InstallerStage>("checking");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<InstallerError | null>(null);
  const [busy, setBusy] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

  const checkRelease = useCallback(async () => {
    setStage("checking");
    setError(null);
    try {
      setRelease(await api.checkRelease());
      setStage("ready");
    } catch (caught) {
      setError(getError(caught));
      setStage("error");
    }
  }, [api]);

  useEffect(() => {
    const removeStage = api.onStage((nextStage) => {
      setStage(nextStage);
      if (nextStage === "downloading" || nextStage === "extracting" || nextStage === "installing" || nextStage === "launching") setBusy(true);
      if (nextStage === "completed" || nextStage === "error") setBusy(false);
    });
    const removeProgress = api.onProgress(setProgress);
    const removeError = api.onError((nextError) => {
      setError(nextError);
      setStage("error");
      setBusy(false);
    });
    void checkRelease();
    void api.getDefaultDirectory().then(setDirectory).catch((caught) => setError(getError(caught)));
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const onMediaChange = () => setReducedMotion(media?.matches ?? false);
    media?.addEventListener?.("change", onMediaChange);
    return () => {
      removeStage();
      removeProgress();
      removeError();
      media?.removeEventListener?.("change", onMediaChange);
    };
  }, [api, checkRelease]);

  const chooseDirectory = async () => {
    try {
      const selected = await api.chooseDirectory();
      if (selected) { setDirectory(selected); setError(null); }
    } catch (caught) { setError(getError(caught)); }
  };

  const startInstall = async () => {
    if (!release || !directory || busy) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      await api.startInstall(directory);
    } catch (caught) {
      setError(getError(caught));
      setStage("error");
      setBusy(false);
    }
  };

  const retry = async () => {
    setProgress(null);
    await checkRelease();
  };

  const progressText = stage === "downloading" && progress?.percent != null ? `${progress.percent}%` : stage === "ready" ? "Можно начинать" : stage === "completed" ? "Готово" : "";
  const activity = ["checking", "downloading", "extracting", "installing", "launching"].includes(stage);
  const StageIcon = stage === "downloading" ? Download : stage === "completed" ? CheckCircle2 : stage === "extracting" ? PackageOpen : stage === "error" ? AlertTriangle : ShieldCheck;
  const currentIndex = stageIndex(stage);
  const isComplete = stage === "completed";
  const shellClass = useMemo(() => `installer-shell${reducedMotion ? " reduced-motion" : ""}`, [reducedMotion]);

  return (
    <main className={shellClass}>
      <header className="installer-titlebar">
        <div className="drag-region" />
        <span className="titlebar-label">Mados Installer</span>
        <button className="titlebar-close no-drag" aria-label="Закрыть" onClick={() => void api.quit()}><X size={16} /></button>
      </header>

      <section className="installer-content">
        <div className="installer-brand">
          <div className="installer-logo"><img src={catLogo} alt="Mados Launcher" /></div>
          <div><p className="eyebrow">Официальная установка</p><h1>Mados Launcher</h1><p className="subtitle">Последняя сборка из GitHub Releases</p></div>
        </div>

        <div className="release-card">
          <div className="release-icon"><PackageOpen size={22} /></div>
          <div className="release-copy">
            <span className="eyebrow">Последняя стабильная версия</span>
            <strong>{release?.name ?? "Проверяем GitHub Releases…"}</strong>
            <span>{release ? `${release.assetName} · ${formatBytes(release.sizeBytes)} · Windows x64` : "Подключаемся к репозиторию"}</span>
          </div>
          {release && <span className="release-check"><ShieldCheck size={15} /> Stable</span>}
        </div>

        <label className="directory-field">
          <span>Папка установки</span>
          <div className="directory-input"><FolderOpen size={17} /><input aria-label="Папка установки" title={directory} value={directory} readOnly placeholder="Выберите папку для Mados Launcher" /><button disabled={busy} className="secondary-button no-drag" type="button" aria-label="Выбрать папку" onClick={() => void chooseDirectory()}>Выбрать папку</button></div>
        </label>

        {error && <div className="error-card"><AlertTriangle size={18} /><div><strong>Не удалось продолжить</strong><span>{error.message}</span></div>{error.retryable && <button className="icon-button no-drag" aria-label="Повторить" onClick={() => void retry()}><RefreshCw size={17} /></button>}</div>}

        <div className="installer-progress-card">
          <div className="progress-heading"><span className={`progress-label stage-${stage}`}><StageIcon key={stage} size={16} />{STAGE_LABELS[stage]}</span><span>{progressText}</span></div>
          <div role="progressbar" aria-label={STAGE_LABELS[stage]} aria-valuenow={stage === "downloading" ? progress?.percent ?? undefined : undefined} className={`progress-track ${activity && (stage !== "downloading" || progress?.percent == null) ? "indeterminate" : ""}`}><span style={{ width: `${stage === "downloading" ? progress?.percent ?? 0 : isComplete ? 100 : 0}%` }} /></div>
          {progress && stage === "downloading" && <small>{formatBytes(progress.receivedBytes)}{progress.totalBytes ? ` из ${formatBytes(progress.totalBytes)}` : ""}</small>}
        </div>

        <div className="stage-list" aria-label="Стадии установки">
          {STAGES.map((item, index) => <div className={`stage-item ${index < currentIndex || (isComplete && index === currentIndex) ? "done" : ""} ${item === stage ? "active" : ""}`} key={item}><span className="stage-dot">{index < currentIndex || (isComplete && index === currentIndex) ? <Check size={13} /> : index + 1}</span><span>{STAGE_LABELS[item]}</span></div>)}
        </div>

        <footer className="installer-actions">
          {isComplete ? <><button className="secondary-button" onClick={() => void api.openDirectory(directory)}><FolderOpen size={17} /> Открыть папку</button><button className="primary-button" onClick={() => void api.quit()}><CheckCircle2 size={17} /> Готово</button></> : busy ? <button className="secondary-button" onClick={() => void api.cancelInstall()}><X size={17} /> Отменить</button> : <button className="primary-button" disabled={!release || !directory} onClick={() => void startInstall()}><Download size={17} /> Установить</button>}
        </footer>

        <div className="installer-note"><ShieldCheck size={14} />{isComplete ? "Лаунчер запущен. Установщик сейчас закроется." : "Загрузка напрямую из GitHub · Ваши данные сохраняются"}</div>
      </section>
    </main>
  );
}
