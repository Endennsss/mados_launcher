import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AlertTriangle,
    Activity,
    HardDrive,
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
import { LaunchProfiles, type ProfileLoadState } from "./LaunchProfiles";
import { ViewState } from "./ViewState";
import type { LaunchProfileDraft } from "./launch-profiles";
import { buildVariantLabel, configChanges as configChangesPreview, formatBuildSize, importStageLabel, isLocalProcessActive, localStatusLabels } from "./tools-ui";
import { useConfirm } from "./ConfirmDialog";
import { SelectField } from "./SelectField";
import { ActionMenu } from "./ActionMenu";
import { ToolsJourney, type ToolsStep } from "./ToolsJourney";
import { LocalServerLogs } from "./LocalServerLogs";
import { DiagnosticsView } from "./DiagnosticsView";
import { PersonalBackupView } from "./PersonalBackupView";
import { ReplayLibraryView } from "./ReplayLibraryView";
import { Archive, Clapperboard } from "lucide-react";
import { StorageView } from "./StorageView";

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
    accountId,
    diagnosticRequest,
    autoDiagnose = false,
    onDiagnosticStarted,
    onDiagnosticLogin,
    onError,
    launchProfiles = [],
    launchProfilesBusy = false,
    profileStatus,
    onUseLaunchProfile,
    onCreateLaunchProfile,
    onUpdateLaunchProfile,
    onRemoveLaunchProfile,
}: {
    accountId?: string;
    diagnosticRequest?: {address:string;revision:number}|null;
    autoDiagnose?: boolean;
    onDiagnosticStarted?: ()=>void;
    onDiagnosticLogin?:()=>void;
    onError: (message: string | null) => void;
    launchProfiles?: LaunchProfile[];
    launchProfilesBusy?: boolean;
    profileStatus?: ProfileLoadState;
    onUseLaunchProfile?: (profile: LaunchProfile) => void | Promise<void>;
    onCreateLaunchProfile?: (draft: LaunchProfileDraft) => void | Promise<void>;
    onUpdateLaunchProfile?: (id: string, draft: LaunchProfileDraft) => void | Promise<void>;
    onRemoveLaunchProfile?: (profile: LaunchProfile) => void | Promise<void>;
}) {
    const [section,setSection]=useState<"server"|"diagnostics"|"storage"|"personal"|"replays">(diagnosticRequest?"diagnostics":"server");
    useEffect(()=>{if(diagnosticRequest)setSection("diagnostics")},[diagnosticRequest]);
    const [profiles, setProfiles] = useState<LocalServerProfile[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [step, setStep] = useState<ToolsStep>("build");
    const initialStep = useRef(false), focusStep = useRef(false);
    const [detailsLoading, setDetailsLoading] = useState(false), [detailsError, setDetailsError] = useState<string|null>(null), [detailsRetry, setDetailsRetry] = useState(0);
    const goStep = (next:ToolsStep, focus=true) => { focusStep.current=focus; setStep(next); };
    useEffect(()=>{if(focusStep.current){focusStep.current=false;document.querySelector<HTMLElement>(`#tools-${step}-panel h2`)?.focus({preventScroll:true});}},[step]);
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
            setProfiles(Array.isArray(next) ? next : []); if(!next.length)setStep("build");
            if(!initialStep.current){initialStep.current=true;setStep(next.length?"run":"build");}
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
        setDetailsError(null);
        setDetailsLoading(!!selectedId);
        if (!selectedId) {
            return;
        }
        let cancelled = false;
        const showLoadError = (caught: unknown) => {
            if (!cancelled) setDetailsError((previous) => [previous, (caught as Error).message].filter(Boolean).join(" · "));
        };
        // Process controls remain available even when configuration or backups cannot be read.
        void window.mados.localServers.getStatus(selectedId)
            .then((next) => { if (!cancelled) setSnapshot(next); })
            .catch(showLoadError);
        void window.mados.localServers.getConfig(selectedId)
            .then((nextConfig) => {
                if (cancelled) return;
                setConfig(nextConfig);
                setConfigBaseline(nextConfig);
                setConfigMode("fields");
            })
            .catch(showLoadError)
            .finally(() => { if (!cancelled) setDetailsLoading(false); });
        void window.mados.localServers.backups(selectedId)
            .then((next) => { if (!cancelled) setBackups(next); })
            .catch(showLoadError);
        return () => {
            cancelled = true;
        };
    }, [selectedId, onError, detailsRetry]);

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
        if (dirty || updateTarget) {
            const message = [
                dirty ? "Несохранённые изменения конфигурации будут сброшены после успешной установки." : null,
                updateTarget ? `Обновить «${updateTarget.name}»? Сервер будет остановлен. Данные и конфигурация с диска сохранятся в резервной копии.` : null,
            ].filter(Boolean).join(" ");
            if (!await confirm({title: updateTarget ? "Обновить сборку?" : "Установить новую сборку?", message, confirmLabel: "Продолжить установку"})) return;
        }
        const importId = crypto.randomUUID();
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
            if (result.profile?.id) {
                setSelectedId(result.profile.id);
                setDetailsRetry((value) => value + 1);
            }
            goStep("config");
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
        if(action!=="stop"&&config&&configBaseline&&configChangesPreview(configBaseline,config,configMode).length){goStep("config");return;}
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
              goStep("run");
              const nextBackups=await window.mados.localServers.backups(id);
              if(currentSelection.current===id)setBackups(nextBackups);
            }
            await reload();
        } catch (caught) {
            if (currentSelection.current === id) setConfigError((caught as Error).message);
        } finally {
            setBusy(null);
        }
    };

    const status = snapshot?.status ?? "idle";
    const dirty = !!(config && configBaseline && configChangesPreview(configBaseline, config, configMode).length);
    const chooseProfile=async(id:string)=>{
        if(id===selectedId||busy)return;
        if(dirty&&!await confirm({title:"Сменить сборку?",message:"Несохранённые изменения конфигурации будут сброшены.",confirmLabel:"Сменить сборку"}))return;
        setSelectedId(id);goStep("run");
    };
    const retryDetails = async () => {
        if (busy) return;
        if (dirty && !await confirm({title:"Загрузить данные заново?", message:"Несохранённые изменения конфигурации будут сброшены.", confirmLabel:"Загрузить заново"})) return;
        setDetailsRetry(value => value + 1);
    };
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
                    <p className="eyebrow">Ваш центр управления</p>
                    <h1>Инструменты</h1>
                    <p className="page-subtitle">
                        Подключение, свободное место и ваша локальная станция.
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
            <nav className="maintenance-tabs" aria-label="Разделы инструментов">{([{id:"server",label:"Локальный сервер",icon:ServerCog},{id:"diagnostics",label:"Диагностика",icon:Activity},{id:"storage",label:"Хранилище",icon:HardDrive},{id:"personal",label:"Мой Mados",icon:Archive},{id:"replays",label:"Реплеи",icon:Clapperboard}] as const).map(item=><button key={item.id} aria-current={section===item.id?"page":undefined} data-maintenance-tab={item.id} onClick={()=>setSection(item.id)}><item.icon size={18}/>{item.label}</button>)}</nav>
            <div hidden={section!=="diagnostics"}><DiagnosticsView key={diagnosticRequest?.revision??0} initialAddress={diagnosticRequest?.address} autoRun={autoDiagnose} onAutoRun={onDiagnosticStarted} onStorage={()=>setSection("storage")} onLogin={onDiagnosticLogin}/></div>
            {section==="storage"&&<StorageView/>}
            {section==="personal"&&<PersonalBackupView key={accountId} accountId={accountId}/>}
            {section==="replays"&&<ReplayLibraryView key={accountId} accountId={accountId}/>}
            <div className="local-tools-section" hidden={section!=="server"}>
            {profiles.length>0&&<div className="tools-profile-picker"><div><span className="eyebrow">Локальная сборка</span><SelectField label="Активная локальная сборка" value={selectedId??""} options={profiles.map(profile=>({value:profile.id,label:profile.name}))} onChange={id=>void chooseProfile(id)} disabled={busy!==null}/></div><span className="tools-profile-version">{selected?.version??"Версия не указана"}{selected?.platform?` · ${selected.platform} ${selected.architecture}`:""}</span><button className="secondary-button compact-button" disabled={busy!==null} onClick={()=>{setUpdateTargetId(null);goStep("build");}}><PackageOpen size={15}/>Добавить сборку</button></div>}
            <ToolsJourney step={step} hasBuild={!!selected} hasConfig={!!configBaseline} dirty={dirty} running={status==="running"} onChange={next=>goStep(next,false)}/>
            {detailsError&&<ViewState compact kind="error" title="Данные сборки недоступны" description={detailsError} action="Повторить" onAction={()=>void retryDetails()}/>}
            <div className="tools-grid tools-workspace">
                <section className="tool-card tool-import-card" ref={importRef} id="tools-build-panel" hidden={step!=="build"}>
                    <div className="tool-card-head">
                        <span className="tool-card-icon">
                            <Download size={19} />
                        </span>
                        <div>
                            <h2 tabIndex={-1}>
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
                <section className="tool-card tool-server-card" id="tools-run-panel" hidden={step!=="run"}>
                    <div className="tool-card-head">
                        <span className="tool-card-icon">
                            <ServerCog size={19} />
                        </span>
                        <div>
                            <h2 tabIndex={-1}>Управление сервером</h2>
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
                        <ViewState icon={<PackageOpen size={25}/>} title="Сборок пока нет" description="Добавьте CDN-ссылку или ZIP выше."/>
                    ) : (
                        <>
                            {selected && (
                                <div className="local-server-controls">
                                    <div className={`local-server-overview ${status}`}><span className="local-server-emblem" key={status}><ServerCog size={34} strokeWidth={1.5}/></span><div><span className="eyebrow">{status==="running"?"Станция работает":status==="starting"?"Подготавливаем станцию":"Ваша локальная станция"}</span><h3>{selected.name}</h3><p>{status==="running"?"Готовность подтверждена сервером. Можно подключаться из профиля запуска.":status==="starting"?"Ожидаем готовность процесса и ответ /status.":status==="stopping"?"Ожидаем завершения процесса. Журнал продолжает обновляться.":status==="error"?snapshot?.lastError||"Запуск не завершён. Подробности доступны в логах.":"Сборка установлена. Проверьте параметры и начните свою смену."}</p></div></div>
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
                                        <button className="primary-button local-server-primary" disabled={busy !== null || processTransition || status!=="running"&&(dirty||detailsLoading||!config)} onClick={() => void runAction(status === "running" ? "stop" : "start")}>
                                            {processTransition ? <LoaderCircle size={16} className="spin" /> : status === "running" ? <Square size={16} /> : <Play size={16} fill="currentColor" />}
                                            {processActionLabel}
                                        </button>
                                        {status === "running" && <button className="secondary-button" disabled={busy !== null||dirty} onClick={() => void runAction("restart")}><RotateCw size={15} />Перезапустить</button>}
                                        <button className="secondary-button" disabled={busy!==null} onClick={()=>goStep("config")}><Settings size={15}/>Настроить</button>
                                        <ActionMenu key={selected.id} label="Действия сервера" disabled={busy !== null} onError={onError} items={[
                                            {id:"update",label:"Обновить сборку",icon:<Download size={16} />,disabled:processTransition,onSelect:() => {
                                                setUpdateTargetId(selected.id);
                                                goStep("build");
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
                                    {dirty&&<div className="tools-draft-notice" role="status"><AlertTriangle size={16}/><span>Несохранённые изменения. Сохраните настройки перед запуском.</span><button className="text-link" onClick={()=>goStep("config")}>К настройкам<ArrowRight size={14}/></button></div>}
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
                <section className="tool-card tool-config-card" id="tools-config-panel" hidden={step!=="config"}>
                    <div className="tool-card-head">
                        <span className="tool-card-icon">
                            <Settings size={19} />
                        </span>
                        <div>
                            <h2 tabIndex={-1}>Настройка сервера</h2>
                            <p>Основные поля сохраняются с резервной копией.</p>
                        </div>
                        <button
                            className="icon-button"
                            disabled={!selected||busy!==null||detailsLoading}
                            onClick={() => {
                                if (selected) {
                                    if(dirty){setConfigError("Сначала сохраните изменения или переключите редактор, чтобы сбросить их.");return;}
                                    const id = selected.id;
                                    setBusy("config");
                                    void window.mados.localServers
                                        .getConfig(id)
                                        .then((next) => {
                                            if (currentSelection.current !== id) return;
                                            setConfig(next);
                                            setConfigBaseline(next);
                                            setConfigMode("fields");
                                        })
                                        .catch((caught) =>
                                            onError((caught as Error).message),
                                        )
                                        .finally(() => setBusy(null));
                                }
                            }}
                            aria-label="Обновить конфигурацию"
                        >
                            <RefreshCw size={15} />
                        </button>
                    </div>
                    {!selected || !config ? (
                        <ViewState kind={detailsLoading?"loading":"empty"} icon={detailsLoading?<LoaderCircle className="spin" size={22}/>:<Settings size={25}/>} title={detailsLoading?"Загружаем настройки":"Настройте свою станцию"} description={detailsLoading?"Читаем конфигурацию выбранной сборки.":"Выберите установленную сборку, чтобы настроить её."}/>
                    ) : (
                        <div className="tool-config-form">
                            <div className="tool-form-grid">
                                <label>
                                    Имя сервера
                                    <input disabled={busy!==null||isLocalProcessActive(status)}
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
                                    <input disabled={busy!==null||isLocalProcessActive(status)}
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
                                    <input disabled={busy!==null||isLocalProcessActive(status)}
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
                                    <input disabled={busy!==null||isLocalProcessActive(status)}
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
                                    <input disabled={busy!==null||isLocalProcessActive(status)}
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
                            {isLocalProcessActive(status)&&<div className="tool-config-note"><AlertTriangle size={14}/>Остановите сервер перед изменением его настроек.</div>}
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
                                    <textarea disabled={busy!==null||isLocalProcessActive(status)}
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
                                    data-action="save-config-next"
                                    disabled={
                                        busy !== null || dirty&&isLocalProcessActive(status) ||
                                        Boolean(rawTomlError)
                                    }
                                    onClick={() => dirty ? void saveConfig() : goStep("run")}
                                >
                                    <Save
                                        size={16}
                                        className={
                                            busy === "config"
                                                ? "icon-pulse"
                                                : ""
                                        }
                                    />
                                    {dirty?"Сохранить и к запуску":"К запуску"}<ArrowRight size={15}/>
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
                <div hidden={step!=="run"}><LocalServerLogs profileId={selectedId} name={selected?.name??null} lines={logs} onSave={()=>window.mados.localServers.saveLog(selectedId??"")} onClear={()=>{if(selectedId)setLogsByProfile(items=>({...items,[selectedId]:[]}));}}/></div>
            </div>
            {onUseLaunchProfile && onCreateLaunchProfile && onUpdateLaunchProfile && onRemoveLaunchProfile && (
                <LaunchProfiles
                    {...profileStatus}
                    profiles={launchProfiles}
                    busy={launchProfilesBusy}
                    onUse={onUseLaunchProfile}
                    onCreate={onCreateLaunchProfile}
                    onUpdate={onUpdateLaunchProfile}
                    onRemove={onRemoveLaunchProfile}
                />
            )}
            </div>
        </section>
    );
}
