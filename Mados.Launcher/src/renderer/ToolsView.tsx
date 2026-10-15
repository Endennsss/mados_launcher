import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AlertTriangle,
    ArrowRight,
    Check,
    CheckCircle2,
    ChevronDown,
    Download,
    FileArchive,
    FolderOpen,
    Link2,
    LoaderCircle,
    PackageOpen,
    Play,
    RefreshCw,
    RotateCw,
    Save,
    ServerCog,
    Settings,
    ShieldCheck,
    Square,
    Terminal,
    Trash2,
    X,
} from "lucide-react";
import type {
    CdnInspection,
    CdnImportRequest,
    CdnProgress,
    LocalServerConfig,
    LocalServerLogLine,
    LocalServerProfile,
    LocalServerSnapshot,
    LaunchProfile,
} from "../contracts/launcher";
import { LaunchProfiles } from "./LaunchProfiles";
import type { LaunchProfileDraft } from "./launch-profiles";
import { buildVariantLabel, configChanges as configChangesPreview, formatBuildSize, importStageLabel, isLocalProcessActive, localStatusLabels } from "./tools-ui";
import { useConfirm } from "./ConfirmDialog";
import { SelectField } from "./SelectField";
import { ActionMenu } from "./ActionMenu";

function formatBackupDate(value: string): string {
    return new Date(value).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}
export function ToolsView({
    onError,
    launchProfiles = [],
    launchProfilesBusy = false,
    onUseLaunchProfile,
    onCreateLaunchProfile,
    onUpdateLaunchProfile,
    onRemoveLaunchProfile,
}: {
    onError: (message: string | null) => void;
    launchProfiles?: LaunchProfile[];
    launchProfilesBusy?: boolean;
    onUseLaunchProfile?: (profile: LaunchProfile) => void | Promise<void>;
    onCreateLaunchProfile?: (draft: LaunchProfileDraft) => void | Promise<void>;
    onUpdateLaunchProfile?: (id: string, draft: LaunchProfileDraft) => void | Promise<void>;
    onRemoveLaunchProfile?: (profile: LaunchProfile) => void | Promise<void>;
}) {
    const [profiles, setProfiles] = useState<LocalServerProfile[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const confirm = useConfirm(selectedId);
    const [sourceUrl, setSourceUrl] = useState("");
    const [profileName, setProfileName] = useState("");
    const [inspection, setInspection] = useState<CdnInspection | null>(null);
    const [selectedBuildId, setSelectedBuildId] = useState<string | null>(null);
    const [archivePath, setArchivePath] = useState<string | null>(null);
    const [updateTargetId, setUpdateTargetId] = useState<string | null>(null);
    const [busy, setBusy] = useState<
        "inspect" | "import" | "action" | "config" | null
    >(null);
    const [pendingAction, setPendingAction] = useState<"start" | "stop" | "restart" | null>(null);
    const [progress, setProgress] = useState<{
        percent: number | null;
        message: string;
    } | null>(null);
    const [snapshots, setSnapshots] = useState<Record<string, LocalServerSnapshot>>({});
    const [config, setConfig] = useState<LocalServerConfig | null>(null);
    const [configMode, setConfigMode] = useState<"fields" | "raw">("fields");
    const [configBaseline, setConfigBaseline] =
        useState<LocalServerConfig | null>(null);
    const [logsByProfile, setLogsByProfile] = useState<Record<string, LocalServerLogLine[]>>({});
    const [configError, setConfigError] = useState<string | null>(null);
    const [portNotice, setPortNotice] = useState<string | null>(null);
    const [operationId, setOperationId] = useState<string | null>(null);
    const [backups, setBackups] = useState<
        Array<{
            id: string;
            profileId: string;
            createdAt: string;
            reason: string;
        }>
    >([]);
    const [advanced, setAdvanced] = useState(false);
    const currentOperation = useRef<string | null>(null);
    const cancelledOperation = useRef<string | null>(null);
    const currentSelection = useRef<string | null>(null);
    const importRef = useRef<HTMLElement>(null);
    currentSelection.current = selectedId;

    const selected = useMemo(
        () => profiles.find((profile) => profile.id === selectedId) ?? null,
        [profiles, selectedId],
    );
    const updateTarget = profiles.find((profile) => profile.id === updateTargetId);
    const snapshot = selectedId ? snapshots[selectedId] : undefined;
    const logs = selectedId ? logsByProfile[selectedId] ?? [] : [];
    const setSnapshot = (value: LocalServerSnapshot) => {
        if (!value.profileId) return;
        setSnapshots((items) => ({ ...items, [value.profileId!]: value }));
    };

    const reload = useCallback(async () => {
        try {
            const next = await window.mados.localServers.list();
            setProfiles(Array.isArray(next) ? next : []);
            setSelectedId((current) =>
                current && next.some((item) => item.id === current)
                    ? current
                    : (next[0]?.id ?? null),
            );
        } catch (caught) {
            onError((caught as Error).message);
        }
    }, [onError]);

    useEffect(() => {
        void reload();
    }, [reload]);

    useEffect(() => {
        setConfig(null);
        setConfigBaseline(null);
        setConfigError(null);
        setBackups([]);
        setPortNotice(null);
        setAdvanced(false);
        if (!selectedId) {
            return;
        }
        let cancelled = false;
        void Promise.all([
            window.mados.localServers.getStatus(selectedId),
            window.mados.localServers.getConfig(selectedId),
            window.mados.localServers.backups(selectedId),
        ])
            .then(([nextSnapshot, nextConfig, nextBackups]) => {
                if (cancelled) return;
                setSnapshot(nextSnapshot);
                setConfig(nextConfig);
                setConfigBaseline(nextConfig);
                setConfigMode("fields");
                setBackups(nextBackups);
            })
            .catch((caught) => {
                if (!cancelled) onError((caught as Error).message);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedId, onError]);

    useEffect(
        () =>
            window.mados.onEvent((event) => {
                if (event.event === "cdn.progress") {
                    const data = event.data as CdnProgress;
                    if (data.operationId !== currentOperation.current) return;
                    setProgress({
                        percent:
                            typeof data.percent === "number"
                                ? data.percent
                                : null,
                        message: data.message ?? importStageLabel(data.stage),
                    });
                    if (data.stage === "cancelled") {
                        setBusy(null);
                        setOperationId(null);
                        currentOperation.current = null;
                    }
                }
                if (event.event === "cdn.completed") {
                    if ((event.data as { operationId?: string }).operationId !== currentOperation.current) return;
                    setProgress({
                        percent: 100,
                        message: "Сборка установлена",
                    });
                    void reload();
                }
                if (event.event === "cdn.failed") {
                    if ((event.data as { operationId?: string }).operationId !== currentOperation.current || cancelledOperation.current === currentOperation.current) return;
                    setProgress(null);
                    onError(
                        (event.data as { message?: string }).message ??
                            "Не удалось установить сборку",
                    );
                }
                if (event.event === "localServer.status") {
                    const next = event.data as LocalServerSnapshot;
                    if (next?.profileId) {
                        setSnapshot(next);
                    }
                }
                if (event.event === "localServer.log") {
                    const line = event.data as LocalServerLogLine;
                    if (line?.line && line.profileId) setLogsByProfile((items) => ({ ...items, [line.profileId]: [...(items[line.profileId] ?? []), line].slice(-250) }));
                }
            }),
        [onError, reload],
    );

    const inspect = async () => {
        const value = sourceUrl.trim();
        if (!value) {
            onError("Вставьте HTTPS-ссылку на CDN-сборку.");
            return;
        }
        setBusy("inspect");
        onError(null);
        setInspection(null);
        setSelectedBuildId(null);
        setProgress(null);
        try {
            const next = await window.mados.tools.cdnInspect(value);
            setInspection(next);
            setSelectedBuildId(
                next.recommendedBuildId ?? next.builds[0]?.id ?? null,
            );
        } catch (caught) {
            onError((caught as Error).message);
        } finally {
            setBusy(null);
        }
    };

    const chooseArchive = async () => {
        try {
            const path = await window.mados.pickLocalServerArchive();
            if (path) {
                setArchivePath(path);
                setSourceUrl("");
                setInspection(null);
                setSelectedBuildId(null);
            }
        } catch (caught) {
            onError((caught as Error).message);
        }
    };

    const importBuild = async () => {
        if (!archivePath && !selectedBuildId) {
            onError("Сначала проверьте CDN-ссылку или выберите ZIP.");
            return;
        }
        const importId = crypto.randomUUID();
        if (updateTarget && !await confirm(`Обновить «${updateTarget.name}»? Сервер будет остановлен. Данные и конфигурация сохранятся в резервной копии.`)) return;
        currentOperation.current = importId;
        cancelledOperation.current = null;
        setBusy("import");
        setOperationId(importId);
        onError(null);
        setProgress({ percent: 0, message: "Начинаем установку…" });
        try {
            const request: CdnImportRequest = archivePath
                ? {
                      operationId: importId,
                      localPath: archivePath,
                      profileName: profileName.trim() || undefined,
                      profileId: updateTarget?.id,
                  }
                : {
                      operationId: importId,
                      sourceUrl: sourceUrl.trim(),
                      buildId: selectedBuildId ?? undefined,
                      profileName: profileName.trim() || undefined,
                      profileId: updateTarget?.id,
                  };
            const result = await window.mados.tools.cdnImport(request);
            await reload();
            if (result.profile?.id) setSelectedId(result.profile.id);
            setArchivePath(null);
            setInspection(null);
            setSourceUrl("");
            setProfileName("");
            setUpdateTargetId(null);
            setProgress({ percent: 100, message: "Сборка установлена" });
        } catch (caught) {
            if (cancelledOperation.current === importId) setProgress({ percent: null, message: "Установка отменена" });
            else { setProgress(null); onError((caught as Error).message); }
        } finally {
            setBusy(null);
            setOperationId(null);
            currentOperation.current = null;
        }
    };

    const cancelImport = async () => {
        if (!operationId) return;
        cancelledOperation.current = operationId;
        try {
            await window.mados.tools.cdnCancel(operationId);
            setProgress({ percent: null, message: "Отменяем установку…" });
        } catch (caught) {
            onError((caught as Error).message);
            cancelledOperation.current = null;
        }
    };

    const runAction = async (action: "start" | "stop" | "restart") => {
        if (!selected) return;
        if (
            action === "stop" &&
            !await confirm("Остановить локальный сервер?")
        )
            return;
        setBusy("action");
        setPendingAction(action);
        onError(null);
        try {
            const next = await window.mados.localServers[action](selected.id);
            setSnapshot(next);
        } catch (caught) {
            onError((caught as Error).message);
        } finally {
            setBusy(null);
            setPendingAction(null);
        }
    };

    const saveConfig = async () => {
        if (!selected || !config) return;
        setBusy("config");
        onError(null);
        setConfigError(null);
        const id = selected.id;
        try {
            const saved = await window.mados.localServers.saveConfig(
                selected.id,
                config,
                configMode,
            );
            if (currentSelection.current === id) {
              setConfig(saved);
              setConfigBaseline(saved);
              setPortNotice("Конфигурация сохранена");
              setBackups(await window.mados.localServers.backups(id));
            }
            await reload();
        } catch (caught) {
            if (currentSelection.current === id) setConfigError((caught as Error).message);
        } finally {
            setBusy(null);
        }
    };

    const status = snapshot?.status ?? "idle";
    const statusLabel = localStatusLabels;
    const readyToImport = Boolean(archivePath || selectedBuildId);
    const processTransition = pendingAction !== null || ["starting", "stopping", "downloading", "extracting"].includes(status);
    const processActionLabel = pendingAction === "restart" ? "Перезапускается…"
        : pendingAction === "stop" || status === "stopping" ? "Останавливается…"
        : pendingAction === "start" || status === "starting" ? "Запускается…"
        : processTransition ? `${statusLabel[status]}…`
        : status === "running" ? "Остановить" : "Запустить";
    const rawTomlError = configMode === "raw" && config && config.rawToml.trim() && !/\[[^\]]+\]/.test(config.rawToml)
        ? "В TOML не найдено ни одной секции [section]. Проверьте формат."
        : null;
    const setConfigEditorMode = async (next: "raw" | "fields") => {
        if (next === configMode) return;
        if (config && configBaseline && configChangesPreview(configBaseline, config, configMode).length > 0) {
            if (!await confirm("Сменить редактор и сбросить несохранённые изменения? Сохраните их, если хотите продолжить в другом режиме.")) return;
        }
        setConfig(configBaseline); setConfigError(null); setConfigMode(next); setAdvanced(next === "raw");
    };
    return (
        <section className="page page-enter tools-page">
            <div className="page-heading">
                <div>
                    <p className="eyebrow">Ваша станция</p>
                    <h1>Инструменты</h1>
                    <p className="page-subtitle">
                        Установите сервер из CDN или ZIP и управляйте им прямо
                        из лаунчера.
                    </p>
                </div>
                <button
                    className="icon-button"
                    onClick={() => void reload()}
                    data-tooltip="Обновить сборки"
                    aria-label="Обновить сборки"
                >
                    <RefreshCw
                        size={17}
                        className={busy === "action" ? "icon-refreshing" : ""}
                    />
                </button>
            </div>
            <div className="tools-grid">
                <section className="tool-card tool-import-card" ref={importRef}>
                    <div className="tool-card-head">
                        <span className="tool-card-icon">
                            <Download size={19} />
                        </span>
                        <div>
                            <h2>
                                {updateTarget
                                    ? "Обновить сборку"
                                    : "Добавить сборку"}
                            </h2>
                            <p>
                                {updateTarget
                                    ? `Сохранит data и конфигурацию профиля «${updateTarget.name}».`
                                    : "Публичная CDN-ссылка или готовый ZIP."}
                            </p>
                        </div>
                        {updateTarget && <button className="ghost-button" disabled={busy !== null} onClick={() => { setUpdateTargetId(null); setProfileName(""); }}>Новая сборка</button>}
                    </div>
                    <div className="tool-import-form">
                        <label>
                            CDN URL
                            <input
                                value={sourceUrl}
                                disabled={busy !== null}
                                onChange={(event) => {
                                    setSourceUrl(event.target.value);
                                    setArchivePath(null);
                                    setInspection(null);
                                    setSelectedBuildId(null);
                                }}
                                placeholder="https://cdn.ss14.org/fork/fish_station"
                                spellCheck={false}
                            />
                        </label>
                        <div className="tool-inline-actions">
                            <button
                                className={readyToImport ? "secondary-button" : "primary-button"}
                                disabled={busy !== null || !sourceUrl.trim()}
                                onClick={() => void inspect()}
                            >
                                {busy === "inspect" ? <LoaderCircle size={15} className="spin" /> : <Link2 size={15} />}
                                {busy === "inspect" ? "Проверяем ссылку…" : "Проверить ссылку"}
                            </button>
                            <button
                                className="ghost-button"
                                disabled={busy !== null}
                                onClick={() => void chooseArchive()}
                            >
                                <FileArchive size={15} />
                                {archivePath ? "ZIP выбран" : "Выбрать ZIP"}
                            </button>
                        </div>
                        {archivePath && (
                            <div className="tool-file">
                                <FileArchive size={15} />
                                <span>{archivePath}</span>
                                <button
                                    aria-label="Убрать ZIP"
                                    onClick={() => setArchivePath(null)}
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        )}
                        {inspection && (
                            <div className="cdn-build-list">
                                <div className="tool-subtitle">
                                    Доступные варианты
                                </div>
                                {inspection.builds.map((build) => (
                                    <button
                                        type="button"
                                        key={build.id}
                                        disabled={busy !== null}
                                        className={`cdn-build-option ${selectedBuildId === build.id ? "selected" : ""}`}
                                        onClick={() =>
                                            setSelectedBuildId(build.id)
                                        }
                                    >
                                        <span>
                                            <strong>
                                                {buildVariantLabel(build)}
                                            </strong>
                                            <small>
                                                {build.version ??
                                                    "Версия не указана"}
                                                {build.publishedAt
                                                    ? ` · ${new Date(build.publishedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
                                                    : ""}
                                                {` · ${formatBuildSize(build.sizeBytes)}`}
                                            </small>
                                        </span>
                                        <Check size={15} />
                                    </button>
                                ))}
                            </div>
                        )}
                        <label hidden={!readyToImport}>
                            Имя профиля
                            <input
                                value={profileName}
                                disabled={busy !== null}
                                onChange={(event) =>
                                    setProfileName(event.target.value)
                                }
                                placeholder="Моя локальная станция"
                            />
                        </label>
                        <div className="tool-inline-actions" hidden={!readyToImport && !operationId}>
                            <button
                                className="primary-button"
                                disabled={
                                    busy !== null ||
                                    (!archivePath && !selectedBuildId)
                                }
                                onClick={() => void importBuild()}
                            >
                                <PackageOpen
                                    size={17}
                                    className={
                                        busy === "import" ? "icon-loading" : ""
                                    }
                                />
                                {updateTarget
                                    ? "Обновить сборку"
                                    : "Установить сборку"}
                            </button>
                            {operationId && (
                                <button
                                    className="ghost-button"
                                    onClick={() => void cancelImport()}
                                >
                                    Отменить
                                </button>
                            )}
                        </div>
                        {progress && (
                            <div className="tool-progress">
                                <div>
                                    <span>{progress.message}</span>
                                    {progress.percent !== null && (
                                        <strong>{progress.percent}%</strong>
                                    )}
                                </div>
                                <div
                                    className={`progress-track ${progress.percent === null && operationId ? "indeterminate" : ""}`}
                                >
                                    <span
                                        style={
                                            progress.percent === null
                                                ? undefined
                                                : {
                                                      width: `${progress.percent}%`,
                                                  }
                                        }
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </section>
                <section className="tool-card tool-server-card">
                    <div className="tool-card-head">
                        <span className="tool-card-icon">
                            <ServerCog size={19} />
                        </span>
                        <div>
                            <h2>Локальный сервер</h2>
                            <p>
                                По умолчанию доступен только на этом компьютере.
                            </p>
                        </div>
                        <span className={`tool-status ${status}`}>
                            <span />
                            {statusLabel[status] ?? status}
                        </span>
                    </div>
                    {profiles.length === 0 ? (
                        <div className="tool-empty">
                            <PackageOpen size={22} />
                            <strong>Сборок пока нет</strong>
                            <span>Добавьте CDN-ссылку или ZIP выше.</span>
                        </div>
                    ) : (
                        <>
                            <div className="local-profile-list">
                                {profiles.map((profile) => (
                                    <button
                                        type="button"
                                        className={`local-profile-item ${selectedId === profile.id ? "selected" : ""}`}
                                        disabled={busy !== null}
                                        key={profile.id}
                                        onClick={() =>
                                            setSelectedId(profile.id)
                                        }
                                    >
                                        <span className="local-profile-icon">
                                            <ServerCog size={16} />
                                        </span>
                                        <span>
                                            <strong>{profile.name}</strong>
                                            <small>
                                                {profile.version ??
                                                    "Версия не указана"}{" "}
                                                · {profile.port}
                                            </small>
                                        </span>
                                        <ArrowRight size={15} />
                                    </button>
                                ))}
                            </div>
                            {selected && (
                                <div className="local-server-controls">
                                    <div className="local-server-meta">
                                        <span>
                                            {selected.bindAddress}:
                                            {selected.port}
                                        </span>
                                        {snapshot?.pid && (
                                            <span>PID {snapshot.pid}</span>
                                        )}
                                    </div>
                                    <div className="tool-inline-actions local-server-actions">
                                        <button className="primary-button local-server-primary" disabled={busy !== null || processTransition} onClick={() => void runAction(status === "running" ? "stop" : "start")}>
                                            {processTransition ? <LoaderCircle size={16} className="spin" /> : status === "running" ? <Square size={16} /> : <Play size={16} fill="currentColor" />}
                                            {processActionLabel}
                                        </button>
                                        {status === "running" && <button className="secondary-button" disabled={busy !== null} onClick={() => void runAction("restart")}><RotateCw size={15} />Перезапустить</button>}
                                        <ActionMenu key={selected.id} label="Действия сервера" disabled={busy !== null} onError={onError} items={[
                                            {id:"update",label:"Обновить сборку",icon:<Download size={16} />,disabled:processTransition,onSelect:() => {
                                                setUpdateTargetId(selected.id);
                                                importRef.current?.scrollIntoView({behavior:document.documentElement.classList.contains("reduce-motion") || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",block:"start"});
                                            }},
                                            {id:"port",label:"Проверить порт",icon:<ShieldCheck size={16} />,onSelect:async() => {
                                                const result = await window.mados.localServers.testPort(selected.port, selected.bindAddress);
                                                if (currentSelection.current === selected.id) setPortNotice(result.available ? "Порт свободен" : result.error ?? "Порт занят");
                                            }},
                                            {id:"folder",label:"Открыть папку",icon:<FolderOpen size={16} />,separator:true,onSelect:() => window.mados.localServers.openFolder(selected.id)},
                                            {id:"log",label:"Открыть лог",icon:<Terminal size={16} />,onSelect:() => window.mados.localServers.openLog(selected.id)},
                                            {id:"export",label:"Сохранить лог",icon:<Save size={16} />,onSelect:() => window.mados.localServers.saveLog(selected.id)},
                                            {id:"remove",label:"Удалить профиль",icon:<Trash2 size={16} />,danger:true,separator:true,disabled:isLocalProcessActive(status),onSelect:async() => {
                                                if (!await confirm({title:"Удалить профиль?",message:`Удалить локальный профиль «${selected.name}»?`,confirmLabel:"Удалить",destructive:true})) return;
                                                await window.mados.localServers.remove(selected.id);
                                                setSelectedId(current => current === selected.id ? null : current);
                                                await reload();
                                            }},
                                        ]} />
                                    </div>
                                    {portNotice && (
                                        <div className="tool-config-note">
                                            <CheckCircle2 size={14} />
                                            {portNotice}
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </section>{" "}
                <section className="tool-card tool-config-card">
                    <div className="tool-card-head">
                        <span className="tool-card-icon">
                            <Settings size={19} />
                        </span>
                        <div>
                            <h2>Настройка сервера</h2>
                            <p>Основные поля сохраняются с резервной копией.</p>
                        </div>
                        <button
                            className="icon-button"
                            disabled={!selected}
                            onClick={() => {
                                if (selected)
                                    void window.mados.localServers
                                        .getConfig(selected.id)
                                        .then((next) => {
                                            setConfig(next);
                                            setConfigBaseline(next);
                                            setConfigMode("fields");
                                        })
                                        .catch((caught) =>
                                            onError((caught as Error).message),
                                        );
                            }}
                            aria-label="Обновить конфигурацию"
                        >
                            <RefreshCw size={15} />
                        </button>
                    </div>
                    {!selected || !config ? (
                        <div className="tool-empty">
                            <Settings size={22} />
                            <span>
                                Выберите установленную сборку, чтобы настроить
                                её.
                            </span>
                        </div>
                    ) : (
                        <div className="tool-config-form">
                            <div className="tool-form-grid">
                                <label>
                                    Имя сервера
                                    <input
                                        value={config.name ?? ""}
                                        onChange={(event) => {
                                            setConfigMode("fields");
                                            setConfig({
                                                ...config,
                                                name: event.target.value,
                                            });
                                        }}
                                    />
                                </label>
                                <label>
                                    Hostname
                                    <input
                                        value={config.hostname ?? ""}
                                        onChange={(event) => {
                                            setConfigMode("fields");
                                            setConfig({
                                                ...config,
                                                hostname: event.target.value,
                                            });
                                        }}
                                    />
                                </label>
                                <label>
                                    Порт
                                    <input
                                        type="number"
                                        min={1}
                                        max={65535}
                                        value={config.port}
                                        onChange={(event) => {
                                            setConfigMode("fields");
                                            setConfig({
                                                ...config,
                                                port:
                                                    Number(
                                                        event.target.value,
                                                    ) || 1212,
                                            });
                                        }}
                                    />
                                </label>
                                <label>
                                    Лимит игроков
                                    <input
                                        type="number"
                                        min={1}
                                        value={config.maxPlayers ?? ""}
                                        onChange={(event) => {
                                            setConfigMode("fields");
                                            setConfig({
                                                ...config,
                                                maxPlayers: event.target.value
                                                    ? Number(event.target.value)
                                                    : null,
                                            });
                                        }}
                                    />
                                </label>
                                <label>
                                    Режим авторизации
                                    <input
                                        value={config.authMode ?? ""}
                                        onChange={(event) => {
                                            setConfigMode("fields");
                                            setConfig({
                                                ...config,
                                                authMode: event.target.value,
                                            });
                                        }}
                                    />
                                </label>
                            </div>
                            <div className="tool-config-note">
                                <ShieldCheck size={14} /> Bind по умолчанию:{" "}
                                {config.bindAddress || "127.0.0.1"}
                            </div>
                            {configBaseline &&
                                configChangesPreview(
                                    configBaseline,
                                    config,
                                    configMode,
                                ).length > 0 && (
                                    <div className="tool-config-preview">
                                        <strong>
                                            Изменения перед сохранением
                                        </strong>
                                        {configChangesPreview(
                                            configBaseline,
                                            config,
                                            configMode,
                                        ).map((change) => (
                                            <span key={change}>{change}</span>
                                        ))}
                                    </div>
                                )}
                            <details
                                open={advanced}
                                onToggle={(event) => {
                                    const open = (
                                        event.currentTarget as HTMLDetailsElement
                                    ).open;
                                    setAdvanced(open);
                                    if (open) setConfigEditorMode("raw");
                                    else setConfigEditorMode("fields");
                                }}
                            >
                                <summary>
                                    Расширенный режим <ChevronDown size={14} />
                                </summary>
                                <label>
                                    server_config.toml
                                    <textarea
                                        value={config.rawToml}
                                        onChange={(event) => {
                                            setConfigMode("raw");
                                            setConfig({
                                                ...config,
                                                rawToml: event.target.value,
                                            });
                                        }}
                                        spellCheck={false}
                                        rows={11}
                                    />
                                </label>
                                {rawTomlError && (
                                    <div className="form-error">
                                        <AlertTriangle size={14} />
                                        {rawTomlError}
                                    </div>
                                )}
                            </details>
                            {configError && <div className="form-error"><AlertTriangle size={14} />{configError}</div>}
                            <div className="tool-inline-actions">
                                <button
                                    className="primary-button"
                                    disabled={
                                        busy === "config" ||
                                        Boolean(rawTomlError)
                                    }
                                    onClick={() => void saveConfig()}
                                >
                                    <Save
                                        size={16}
                                        className={
                                            busy === "config"
                                                ? "icon-pulse"
                                                : ""
                                        }
                                    />
                                    Сохранить конфигурацию
                                </button>
                                {backups.length > 0 && (
                                    <SelectField label="Резервная копия" placeholder="Восстановить копию…" value=""
                                      options={backups.map(backup => ({value:backup.id,label:`${formatBackupDate(backup.createdAt)} · ${backup.reason}`}))}
                                      onChange={async backupId => {
                                        if (!selected || !await confirm({title:"Восстановить резервную копию?", message:"Текущие настройки и данные сервера будут заменены выбранной копией.", confirmLabel:"Восстановить"})) return;
                                        const profileId = selected.id;
                                        try {
                                          await window.mados.localServers.rollback(profileId, backupId);
                                          const next = await window.mados.localServers.getConfig(profileId);
                                          const nextBackups = await window.mados.localServers.backups(profileId);
                                          if (currentSelection.current === profileId) { setConfig(next); setConfigBaseline(next); setBackups(nextBackups); }
                                        } catch (caught) { onError((caught as Error).message); }
                                      }} />
                                )}
                            </div>
                        </div>
                    )}
                </section>{" "}
                <section className="tool-card tool-log-card">
                    <div className="tool-card-head">
                        <span className="tool-card-icon">
                            <Terminal size={19} />
                        </span>
                        <div>
                            <h2>Live-логи</h2>
                            <p>
                                {selected
                                    ? `Последние сообщения ${selected.name}`
                                    : "Выберите сервер, чтобы увидеть логи."}
                            </p>
                        </div>
                        <div className="tool-log-actions">
                            <button
                                className="icon-button"
                                disabled={logs.length === 0}
                                onClick={() =>
                                    void window.mados.localServers.saveLog(
                                        selected?.id ?? "",
                                    )
                                }
                                aria-label="Сохранить лог"
                                data-tooltip="Сохранить лог"
                            >
                                <Save size={15} />
                            </button>
                            <button
                                className="icon-button"
                                disabled={logs.length === 0}
                                onClick={() => { if (selectedId) setLogsByProfile((items) => ({ ...items, [selectedId]: [] })); }}
                                aria-label="Очистить логи"
                                data-tooltip="Очистить"
                            >
                                <Trash2 size={15} />
                            </button>
                        </div>
                    </div>
                    <div className="tool-log-view" aria-live="polite">
                        {logs.length === 0 ? (
                            <span className="tool-log-empty">
                                Ожидание запуска…
                            </span>
                        ) : (
                            logs.map((line, index) => (
                                <div
                                    className={`tool-log-line ${line.stream === "stderr" ? "stderr" : ""}`}
                                    key={`${line.timestamp}-${index}`}
                                >
                                    <time>
                                        {new Date(
                                            line.timestamp,
                                        ).toLocaleTimeString()}
                                    </time>
                                    <span>{line.line}</span>
                                </div>
                            ))
                        )}
                    </div>
                </section>
            </div>
            {onUseLaunchProfile && onCreateLaunchProfile && onUpdateLaunchProfile && onRemoveLaunchProfile && (
                <LaunchProfiles
                    profiles={launchProfiles}
                    busy={launchProfilesBusy}
                    onUse={onUseLaunchProfile}
                    onCreate={onCreateLaunchProfile}
                    onUpdate={onUpdateLaunchProfile}
                    onRemove={onRemoveLaunchProfile}
                />
            )}
        </section>
    );
}
