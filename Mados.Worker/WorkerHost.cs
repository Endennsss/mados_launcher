using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.RegularExpressions;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using CodeHollow.FeedReader;
using Microsoft.Toolkit.Mvvm.ComponentModel;
using Serilog;
using Splat;
using SS14.Launcher.Api;
using SS14.Launcher.Models;
using SS14.Launcher.Models.ContentManagement;
using SS14.Launcher.Models.Data;
using SS14.Launcher.Models.Logins;
using SS14.Launcher.Models.Maintenance;
using SS14.Launcher.Models.OverrideAssets;
using SS14.Launcher.Models.Personal;
using SS14.Launcher.Models.Playtime;
using SS14.Launcher.Models.Presence;
using SS14.Launcher.Models.RecentConnections;
using SS14.Launcher.Models.ServerStatus;
using SS14.Launcher.Utility;

namespace SS14.Launcher.Worker;

/// <summary>
/// JSON-RPC worker host used by the Electron renderer. It deliberately owns the
/// launcher's existing services so the new UI cannot accidentally reimplement
/// authentication, server discovery, content updates, or game launching.
/// </summary>
public sealed partial class WorkerHost
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };

    private readonly TextWriter _output;
    private readonly object _writeLock = new();
    private readonly CancellationTokenSource _shutdown = new();
    private readonly object _cdnLock = new();
    private CancellationTokenSource? _cdnCancellation;
    private string? _cdnOperationId;
    private Guid? _localLaunchingAccount;

    private readonly DataManager _data;
    private readonly HttpClient _http;
    private readonly AuthApi _auth;
    private readonly HubApi _hub;
    private readonly LoginManager _login;
    private readonly LauncherInfoManager _launcherInfo;
    private readonly ContentManager _content;
    private readonly OverrideAssetsManager _overrideAssets;
    private readonly Connector _connector;
    private readonly Updater _updater;
    private readonly PlaytimeStore _playtimeStore;
    private readonly PlaytimeTracker _playtimeTracker;
    private readonly RecentConnectionStore _recentConnections;
    private readonly ServerNotesStore _serverNotes;
    private readonly LauncherInsightsStore _insights;
    private readonly LocalServerStore _localServerStore;
    private readonly LocalServerManager _localServers;
    private readonly object _serverSnapshotLock = new();
    private readonly Dictionary<string, ServerStatusSnapshot> _serverSnapshots = new(StringComparer.OrdinalIgnoreCase);
    private readonly ServerCatalogCache _catalog;
    private readonly List<Task> _catalogMonitoring = [];
    private readonly Dictionary<Guid, Task<ServerCatalogResult>> _lastMonitoredCatalog = [];
    private readonly FavoriteMonitoringQueue _monitoringQueue = new();
    private WorkerCommandBridge? _legacyBridge;
    private string? _pendingLegacyReason;

    private Task? _connectionTask;
    private CancellationTokenSource? _connectionCancellation;
    private PendingRecentConnection? _pendingRecentConnection;
    private Updater.UpdateStatus? _lastNotificationUpdateStatus;
    private readonly PresenceTracker _presence;
    private readonly ManagedStorage _storage;
    private readonly ConnectionDiagnostics _diagnostics;
    private readonly MaintenanceGate _maintenanceGate;

    private WorkerHost(TextWriter output)
    {
        _output = output;
        _data = Locator.Current.GetRequiredService<DataManager>();
        _http = Locator.Current.GetRequiredService<HttpClient>();
        _auth = Locator.Current.GetRequiredService<AuthApi>();
        _hub = Locator.Current.GetRequiredService<HubApi>();
        _login = Locator.Current.GetRequiredService<LoginManager>();
        _launcherInfo = Locator.Current.GetRequiredService<LauncherInfoManager>();
        _content = Locator.Current.GetRequiredService<ContentManager>();
        _overrideAssets = Locator.Current.GetRequiredService<OverrideAssetsManager>();
        _updater = Locator.Current.GetRequiredService<Updater>();
        _connector = new Connector();
        _playtimeStore = new PlaytimeStore();
        _playtimeTracker = new PlaytimeTracker(_playtimeStore, update => SendEvent("playtime.updated", update));
        _recentConnections = new RecentConnectionStore();
        _serverNotes = new ServerNotesStore();
        _insights = new LauncherInsightsStore();
        _catalog = new ServerCatalogCache(_http, CatalogOnUpdated);
        _localServerStore = new LocalServerStore();
        // CDN downloads use a separate no-redirect client. LocalServerManager
        // validates every resolved address so a public URL cannot pivot into a
        // loopback/private endpoint through DNS or redirects.
        var cdnHttp = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromMinutes(10)
        };
        _localServers = new LocalServerManager(_http, _localServerStore, cdnHttp: cdnHttp);
        _localServers.Changed += LocalServerOnChanged;
        _maintenanceGate = new MaintenanceGate(StorageBusy);
        _storage = new ManagedStorage(LauncherPaths.PathContentDb, LauncherPaths.DirEngineInstallations, LauncherPaths.DirModuleInstallations, LauncherPaths.DirLogs, Path.Combine(LauncherPaths.DirUserData,"local-servers"), StorageBusy);
        _diagnostics = new ConnectionDiagnostics(new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(7)},LauncherPaths.DirEngineInstallations,LauncherPaths.DirLocalData);
        InitializeToolkit();

        _presence = new PresenceTracker(
            (address, cancel) => ServerStatusProbe.FetchAsync(_http, address, cancel),
            snapshot => SendEvent("presence.updated", snapshot),
            UpdateServerSnapshot);

        _connector.PropertyChanged += ConnectorOnPropertyChanged;
        _updater.PropertyChanged += UpdaterOnPropertyChanged;
    }

    public static async Task RunAsync(TextWriter output)
    {
        var host = new WorkerHost(output);
        await host.RunCoreAsync();
    }

    private async Task RunCoreAsync()
    {
        try
        {
            SendEvent("app.startup", new { stage = "checking-data", message = "Проверяем данные…" });
            _launcherInfo.Initialize();
            CleanupTransferredCache();
            _content.Initialize();
            _overrideAssets.Initialize();
            await _login.Initialize();
            if (_data.SelectedLoginId is { } selected && _login.Logins.Lookup(selected).HasValue)
            {
                _login.ActiveAccountId = selected;
            }
            SendEvent("app.ready", await GetStateAsync());
            ConfigurePresence();
            _legacyBridge = new WorkerCommandBridge(HandleLegacyCommandAsync);
            _legacyBridge.Start();
        }
        catch (Exception e)
        {
            Log.Error(e, "Worker initialization failed");
            SendEvent("app.error", new WorkerError("INITIALIZATION_FAILED", "Launcher initialization failed", e.Message));
            return;
        }

        var backgroundRequests = new List<Task>();
        while (!_shutdown.IsCancellationRequested)
        {
            string? line;
            try
            {
                // Shutdown cancels this read so the worker reaches the cleanup
                // section instead of waiting forever for stdin to close.
                line = await Console.In.ReadLineAsync(_shutdown.Token);
            }
            catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
            {
                break;
            }
            if (line == null)
                break;

            if (string.IsNullOrWhiteSpace(line))
                continue;

            var background = false;
            try
            {
                using var request = JsonDocument.Parse(line);
                background = request.RootElement.TryGetProperty("method", out var method)
                    && method.ValueKind == JsonValueKind.String
                    && method.GetString() is "tools.cdn.import" or "localServers.create" or "localServers.start" or "localServers.restart" or "servers.info" or "diagnostics.run" or "storage.scan" or "storage.preview" or "storage.clean" or "cache.move" or "replays.add";
            }
            catch (JsonException) { /* HandleLineAsync returns the protocol error. */ }
            if (background)
            {
                backgroundRequests.RemoveAll(task => task.IsCompleted);
                backgroundRequests.Add(HandleLineAsync(line));
            }
            else await HandleLineAsync(line);
        }

        _shutdown.Cancel();
        _cacheCancellation?.Cancel();
        StopSeatWatch();
        lock (_cdnLock) _cdnCancellation?.Cancel();
        await _catalog.DisposeAsync();
        await Task.WhenAll(_catalogMonitoring);
        await Task.WhenAll(backgroundRequests);
        if(_seatLoop!=null)await _seatLoop;
        _connectionCancellation?.Cancel();
        _presence.Dispose();
        _playtimeTracker.Stop();
        await _localServers.DisposeAsync();
        if (_legacyBridge != null)
            await _legacyBridge.DisposeAsync();
        _login.Stop();
    }

    private Task HandleLegacyCommandAsync(string command)
    {
        if (command is ":Ping" or ":RedialWait")
            return Task.CompletedTask;

        if (command.StartsWith("R", StringComparison.Ordinal))
        {
            _pendingLegacyReason = null;
            try { _pendingLegacyReason = Encoding.UTF8.GetString(Convert.FromHexString(command[1..])); }
            catch (FormatException) { Log.Warning("Ignoring malformed encoded Loader reason"); }
            return Task.CompletedTask;
        }

        if (command.StartsWith("r", StringComparison.Ordinal))
        {
            _pendingLegacyReason = command[1..];
            return Task.CompletedTask;
        }

        string? uri = null;
        if (command.StartsWith("C", StringComparison.Ordinal))
        {
            try { uri = Encoding.UTF8.GetString(Convert.FromHexString(command[1..])); }
            catch (FormatException) { Log.Warning("Ignoring malformed encoded Loader command"); }
        }
        else if (command.StartsWith("c", StringComparison.Ordinal))
        {
            uri = command[1..];
        }

        if (uri is not null && Uri.TryCreate(uri, UriKind.Absolute, out var parsed)
            && parsed.Scheme is "ss14" or "ss14s")
        {
            try
            {
                var reason = _pendingLegacyReason;
                _pendingLegacyReason = null;
                StartConnection(JsonSerializer.SerializeToElement(new { address = uri, reason }, JsonOptions));
            }
            catch (WorkerRpcException e)
            {
                Log.Warning("Loader connection command was rejected: {Code}", e.Error.Code);
            }
        }
        return Task.CompletedTask;
    }

    private async Task HandleLineAsync(string line)
    {
        JsonDocument? document = null;
        try
        {
            document = JsonDocument.Parse(line);
            var root = document.RootElement;
            var requestId = WorkerProtocol.TryGetRequestId(root);
            var validationError = WorkerProtocol.ValidateRequest(root);
            if (validationError is not null)
            {
                SendError(requestId, new WorkerError(validationError, validationError == "UNSUPPORTED_VERSION" ? "Unsupported worker protocol version" : "Request must include a string id and method"));
                return;
            }

            var id = requestId!;
            var method = root.GetProperty("method").GetString()!;

            var parameters = root.TryGetProperty("params", out var paramsElement)
                ? paramsElement
                : default;

            try
            {
                var result = await DispatchAsync(method, parameters);
                SendResponse(id, result);
            }
            catch (WorkerRpcException e)
            {
                Log.Warning("Worker request {Method} failed with {Code}: {Message}", method, e.Error.Code, e.Error.Message);
                SendError(id, e.Error);
            }
            catch (OperationCanceledException)
            {
                SendError(id, new WorkerError("CANCELLED", "The operation was cancelled"));
            }
            catch (LocalServerException error)
            {
                SendError(id, new WorkerError(error.Code, error.Message));
            }
            catch (Exception e)
            {
                Log.Error(e, "Unhandled worker request {Method}", method);
                SendError(id, new WorkerError("INTERNAL_ERROR", "The launcher could not complete the request"));
            }
        }
        catch (JsonException e)
        {
            Log.Warning(e, "Invalid JSON received by worker");
            SendError(null, new WorkerError("INVALID_JSON", "The worker received invalid JSON"));
        }
        finally
        {
            document?.Dispose();
        }
    }

    private async Task<object?> DispatchAsync(string method, JsonElement parameters)
    {
        try
        {
            if(_cacheState.Stage=="ready"&&method is "servers.connect" or "content.openBundle" or "replays.play" or "updates.start" or "localServers.start" or "localServers.restart" or "launchProfiles.use")throw new WorkerRpcException(new WorkerError("CACHE_RESTART_REQUIRED","Кэш перенесён. Перезапустите Mados перед запуском."));
            using var lease = method is "servers.connect" or "content.openBundle" or "updates.start" or "tools.cdn.import" or "localServers.create" or "localServers.start" or "localServers.restart" or "localServers.rollback" or "localServers.remove" ? _maintenanceGate.Use() : null;
            return await DispatchCoreAsync(method,parameters);
        }
        catch(InvalidOperationException error) when(IsMaintenanceMethod(method))
        { throw new WorkerRpcException(new WorkerError("MAINTENANCE_UNAVAILABLE",error.Message)); }
        catch(Exception error) when((IsMaintenanceMethod(method))&&(error is IOException or UnauthorizedAccessException or Microsoft.Data.Sqlite.SqliteException))
        { throw new WorkerRpcException(new WorkerError("MAINTENANCE_FAILED","Не удалось прочитать или обработать данные. Закройте игру и повторите попытку.")); }
    }

    private bool StorageBusy() => _connectionTask is {IsCompleted:false} || _cdnCancellation!=null || _localServers.GetStatus().Status is LocalServerStatus.Starting or LocalServerStatus.Running or LocalServerStatus.Stopping;
    private async Task<object> StorageCleanAsync(JsonElement parameters)
    {
        using var lease=_maintenanceGate.Clean();var planId=RequiredString(parameters,"planId");
        return await Task.Run(()=>_storage.Clean(planId),_shutdown.Token);
    }
    private async Task<object> StoragePreviewAsync(JsonElement parameters)
    {
        if(parameters.ValueKind!=JsonValueKind.Object||!parameters.TryGetProperty("ids",out var ids)||ids.ValueKind!=JsonValueKind.Array||ids.GetArrayLength()>500||ids.EnumerateArray().Any(id=>id.ValueKind!=JsonValueKind.String))throw new WorkerRpcException(new WorkerError("INVALID_PARAMS","Выберите элементы для очистки."));
        var selection=ids.EnumerateArray().Select(id=>id.GetString()!).ToArray();
        return await Task.Run(()=>_storage.Preview(selection),_shutdown.Token);
    }
    private async Task<object?> DispatchCoreAsync(string method, JsonElement parameters)
    {
        return method switch
        {
            "cache.info" => new { paths=_cacheTransfer.Info(), state=_cacheState, warnings=_cacheWarnings },
            "cache.move" => await MoveCacheAsync(parameters),
            "cache.cancel" => CancelCache(),
            "replays.list" => _replays.List(RequireActiveAccountForNotes().ToString()),
            "replays.add" => AddReplay(parameters),
            "replays.update" => UpdateReplay(parameters),
            "replays.remove" => RemoveReplay(parameters),
            "replays.play" => PlayReplay(parameters),
            "personal.snapshot" => PersonalSnapshot(),
            "personal.apply" => await ApplyPersonalAsync(parameters),
            "seatWatch.get" => _seatWatch.Snapshot,
            "seatWatch.start" => StartSeatWatch(parameters),
            "seatWatch.stop" => StopSeatWatch(),
            "diagnostics.run" => await _diagnostics.RunAsync(RequiredString(parameters,"address"),_login.ActiveAccount?.Status==AccountLoginStatus.Available?"valid":_login.ActiveAccount?.Status==AccountLoginStatus.Expired?"expired":"missing",_shutdown.Token),
            "diagnostics.openLogs" => new {path=LauncherPaths.DirLogs},
            "storage.scan" => await Task.Run(()=>_storage.Scan(),_shutdown.Token),
            "storage.preview" => await StoragePreviewAsync(parameters),
            "storage.clean" => await StorageCleanAsync(parameters),
            "app.getState" => await GetStateAsync(),
            "app.getVersion" => new { version = LauncherVersion.Version?.ToString() ?? "unknown", name = "Mados Launcher" },
            "app.openDeepLink" => await OpenDeepLinkAsync(parameters),
            "app.shutdown" => Shutdown(),
            "auth.getAccounts" => GetAccounts(),
            "auth.login" => await LoginAsync(parameters),
            "auth.logout" => await LogoutAsync(parameters),
            "auth.switchAccount" => SwitchAccount(parameters),
            "servers.list" => GetServers(false),
            "servers.refresh" => GetServers(true),
            "servers.info" => await GetServerInfoAsync(parameters),
            "favorites.list" => GetFavorites(),
            "favorites.add" => AddFavorite(parameters),
            "favorites.remove" => RemoveFavorite(parameters),
            "playtime.getSummary" => GetPlaytimeSummary(parameters),
            "playtime.clear" => ClearPlaytime(),
            "recentConnections.list" => ListRecentConnections(parameters),
            "serverNotes.list" => ListServerNotes(),
            "serverNotes.upsert" => UpsertServerNote(parameters),
            "serverNotes.remove" => RemoveServerNote(parameters),
            "monitoring.getFavorites" => GetMonitoringFavorites(),
            "monitoring.refresh" => await RefreshMonitoringAsync(),
            "launchProfiles.list" => ListLaunchProfiles(),
            "launchProfiles.create" => CreateLaunchProfile(parameters),
            "launchProfiles.update" => UpdateLaunchProfile(parameters),
            "launchProfiles.remove" => RemoveLaunchProfile(parameters),
            "launchProfiles.use" => UseLaunchProfile(parameters),
            "notifications.list" => ListNotifications(),
            "notifications.markRead" => MarkNotificationRead(parameters),
            "notifications.clear" => ClearNotifications(),
            "tools.cdn.inspect" => await InspectCdnAsync(parameters),
            "tools.cdn.import" => await ImportCdnAsync(parameters),
            "tools.cdn.cancel" => CancelCdn(parameters),
            "localServers.list" => ListLocalServers(),
            "localServers.create" => await CreateLocalServerAsync(parameters),
            "localServers.update" => UpdateLocalServer(parameters),
            "localServers.remove" => await RemoveLocalServerAsync(parameters),
            "localServers.start" => await StartLocalServerAsync(parameters),
            "localServers.stop" => await StopLocalServerAsync(parameters),
            "localServers.restart" => await RestartLocalServerAsync(parameters),
            "localServers.getStatus" => GetLocalServerStatus(parameters),
            "localServers.getConfig" => await GetLocalServerConfigAsync(parameters),
            "localServers.saveConfig" => await SaveLocalServerConfigAsync(parameters),
            "localServers.testPort" => TestLocalServerPort(parameters),
            "localServers.openFolder" => OpenLocalServerFolder(parameters),
            "localServers.openLog" => OpenLocalServerLog(parameters),
            "localServers.backups" => ListLocalServerBackups(parameters),
            "localServers.rollback" => await RollbackLocalServerAsync(parameters),
            "news.list" => await GetNewsAsync(),
            "settings.get" => GetSettings(),
            "settings.update" => UpdateSettings(parameters),
            "servers.connect" => StartConnection(parameters),
            "connection.cancel" => CancelConnection(),
            "connection.confirmPrivacyPolicy" => ConfirmPrivacyPolicy(parameters),
            "content.openBundle" => StartContentBundle(parameters),
            "updates.getStatus" => GetUpdateStatus(),
            "updates.start" => StartUpdate(parameters),
            _ => throw new WorkerRpcException(new WorkerError("METHOD_NOT_FOUND", $"Unknown worker method: {method}"))
        };
    }

    private Task<object> GetStateAsync()
    {
        var processor = LauncherDiagnostics.GetProcessorModel();
        var intelWarning = processor.Contains("Intel", StringComparison.OrdinalIgnoreCase)
            && Regex.IsMatch(processor, @"i\d+-1[34]\d+(?:[A-Z]+)?(?:\s|$)", RegexOptions.IgnoreCase)
            && !processor.EndsWith("H", StringComparison.OrdinalIgnoreCase)
            && !processor.EndsWith("P", StringComparison.OrdinalIgnoreCase)
            && !processor.EndsWith("U", StringComparison.OrdinalIgnoreCase)
            && !_data.GetCVar(CVars.HasDismissedIntelDegradation);
        return Task.FromResult<object>(new
        {
            ready = true,
            loggedIn = _login.ActiveAccount != null,
            activeAccount = GetAccountDto(_login.ActiveAccount),
            accounts = GetAccounts(),
            favorites = GetFavorites(),
            version = LauncherVersion.Version?.ToString() ?? "unknown",
            compatibility = new
            {
                // Kept for older IPC consumers. Mados shell updates are owned
                // by Electron/GitHub, not the official launcher's allowlist.
                outOfDate = false,
                earlyAccess = !_data.GetCVar(CVars.HasDismissedEarlyAccessWarning),
                intelDegradation = intelWarning,
                rosetta = OperatingSystem.IsMacOS()
                    && processor.Contains("VirtualApple", StringComparison.OrdinalIgnoreCase)
                    && !_data.GetCVar(CVars.HasDismissedRosettaWarning),
                authOverride = ConfigConstants.IsAuthOverride
            },
            discord = GetDiscordSettings()
            ,window = GetWindowSettings()
        });
    }

    private object GetAccounts()
    {
        return _login.Logins.Items.Select(GetAccountDto).ToArray();
    }

    private object? GetAccountDto(LoggedInAccount? account)
    {
        if (account == null)
            return null;

        return new
        {
            id = account.UserId,
            username = account.Username,
            status = account.Status.ToString().ToLowerInvariant(),
            active = _login.ActiveAccountId == account.UserId
        };
    }

    private async Task<object> LoginAsync(JsonElement parameters)
    {
        StopSeatWatch();
        var username = RequiredString(parameters, "username");
        var password = RequiredString(parameters, "password");
        var tfaCode = OptionalString(parameters, "tfaCode");

        var response = await _auth.AuthenticateAsync(new AuthApi.AuthenticateRequest(null, null, password, tfaCode) with
        {
            Username = username
        });

        if (!response.IsSuccess)
        {
            throw new WorkerRpcException(new WorkerError(
                response.Code.ToString().ToUpperInvariant(),
                "Authentication failed",
                new { errors = response.Errors }));
        }

        var loginInfo = response.LoginInfo;
        var existing = _login.Logins.Lookup(loginInfo.UserId);
        if (existing.HasValue)
        {
            await _auth.LogoutTokenAsync(existing.Value.LoginInfo.Token.Token);
            _login.UpdateToNewToken(existing.Value, loginInfo.Token);
        }
        else
        {
            _login.AddFreshLogin(loginInfo);
        }

        _login.ActiveAccountId = loginInfo.UserId;
        _data.CommitConfig();
        SendEvent("auth.changed", new { accounts = GetAccounts(), activeAccount = GetAccountDto(_login.ActiveAccount), favorites = GetFavorites() });
        ConfigurePresence();
        return GetAccountDto(_login.ActiveAccount)!;
    }

    private async Task<object> LogoutAsync(JsonElement parameters)
    {
        StopSeatWatch();
        var accountId = OptionalGuid(parameters, "accountId") ?? _login.ActiveAccountId;
        if (accountId == null || !_login.Logins.Lookup(accountId.Value).HasValue)
            throw new WorkerRpcException(new WorkerError("ACCOUNT_NOT_FOUND", "Account was not found"));

        var account = _login.Logins.Lookup(accountId.Value).Value;
        await _auth.LogoutTokenAsync(account.LoginInfo.Token.Token);
        var wasActive = accountId == _login.ActiveAccountId;
        _data.RemoveLogin(account.LoginInfo);
        if (wasActive)
        {
            var next = _login.Logins.Items.FirstOrDefault(item => item.Status != AccountLoginStatus.Expired)
                       ?? _login.Logins.Items.FirstOrDefault();
            _login.ActiveAccountId = next?.UserId;
        }
        _data.CommitConfig();
        SendEvent("auth.changed", new { accounts = GetAccounts(), activeAccount = GetAccountDto(_login.ActiveAccount), favorites = GetFavorites() });
        ConfigurePresence();
        return new { ok = true };
    }

    private object SwitchAccount(JsonElement parameters)
    {
        StopSeatWatch();
        var accountId = RequiredGuid(parameters, "accountId");
        if (!_login.Logins.Lookup(accountId).HasValue)
            throw new WorkerRpcException(new WorkerError("ACCOUNT_NOT_FOUND", "Account was not found"));

        _login.ActiveAccountId = accountId;
        SendEvent("auth.changed", new { accounts = GetAccounts(), activeAccount = GetAccountDto(_login.ActiveAccount), favorites = GetFavorites() });
        ConfigurePresence();
        return GetAccountDto(_login.ActiveAccount)!;
    }

    private ServerCatalogResult GetServers(bool refreshMonitoring)
    {
        var hubs = ConfigConstants.DefaultHubUrls
            .Select(h => new ServerCatalogHub(h, h.Urls[0]))
            .Concat(_data.Hubs.OrderBy(h => h.Priority).Select(h => new ServerCatalogHub(UrlFallbackSet.FromSingle(h.Address), h.Address.AbsoluteUri)))
            .ToArray();
        var result = _catalog.Get(hubs, refreshMonitoring);
        if (refreshMonitoring && _login.ActiveAccountId is { } accountId)
        {
            var refresh = _catalog.Completion;
            if (!_lastMonitoredCatalog.TryGetValue(accountId, out var lastRefresh) || lastRefresh != refresh)
            {
                _lastMonitoredCatalog[accountId] = refresh;
                var favorites = _data.FavoriteServers.Items.Select(f => new FavoriteMonitorTarget(f.Address, f.Name)).ToArray();
                var notify = _data.GetCVar(CVars.FavoriteAvailabilityNotifications);
                _catalogMonitoring.RemoveAll(task => task.IsCompleted);
                _catalogMonitoring.Add(CompleteCatalogMonitoringAsync(refresh, accountId, favorites, notify));
            }
        }
        return result;
    }

    private async Task CompleteCatalogMonitoringAsync(Task<ServerCatalogResult> refresh, Guid accountId,
        FavoriteMonitorTarget[] favorites, bool notify)
    {
        try
        {
            await _monitoringQueue.RunAsync(async () =>
            {
                // Reserve the queue before waiting for the catalog so later
                // manual probes cannot write ahead of this refresh.
                try
                {
                    var result = await refresh;
                    _shutdown.Token.ThrowIfCancellationRequested();
                    // Failed hubs must not turn cached entries into new samples.
                    return await RefreshMonitoringCoreAsync(accountId, favorites, notify, result.Stale ? [] : result.Servers);
                }
                catch (OperationCanceledException) when (_shutdown.IsCancellationRequested) { throw; }
                catch (Exception error)
                {
                    Log.Warning(error, "Favorite monitoring after catalog refresh failed");
                    object? partial = null;
                    try
                    {
                        partial = _insights.GetFavoriteSummaries(accountId, favorites).Select(ToFavoriteMonitorDto).ToArray();
                    }
                    catch (Exception readError)
                    {
                        Log.Warning(readError, "Could not read partial favorite monitoring results");
                    }
                    if (_login.ActiveAccountId == accountId)
                        SendEvent("monitoring.failed", new
                        {
                            accountId, favorites = partial,
                            message = "Не удалось обновить все избранные серверы. Сохранённые данные доступны; попробуйте обновить ещё раз."
                        });
                    return new { ok = false };
                }
            }, _shutdown.Token);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested) { }
    }

    private void CatalogOnUpdated(ServerCatalogResult result)
    {
        lock (_serverSnapshotLock)
        {
            foreach (var server in result.Servers)
            {
                _serverSnapshots[PresenceAddress.Sanitize(server.Address) ?? server.Address] = new ServerStatusSnapshot(
                    server.Name,
                    server.PlayerCount,
                    server.SoftMaxPlayerCount,
                    server.RoundStartTime,
                    server.RunLevel,
                    server.Tags,
                    server.PingMs,
                    server.Language,
                    server.Map,
                    server.Mode);
            }
        }
        SendEvent("servers.updated", result);
    }

    private async Task<object> GetServerInfoAsync(JsonElement parameters)
    {
        var accountId = _login.ActiveAccountId;
        var address = RequiredString(parameters, "address");
        var safeAddress = PresenceAddress.Sanitize(address);
        if (safeAddress == null || !UriHelper.TryParseSs14Uri(safeAddress, out var parsedAddress))
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", "Invalid server address"));
        var hubAddress = OptionalString(parameters, "hubAddress");
        if (string.IsNullOrWhiteSpace(hubAddress))
            hubAddress = ConfigConstants.DefaultHubUrls.FirstOrDefault()?.Urls.FirstOrDefault();
        if (string.IsNullOrWhiteSpace(hubAddress))
            throw new WorkerRpcException(new WorkerError("SERVER_INFO_UNAVAILABLE", "No server hub is configured"));

        if (!hubAddress.EndsWith("/", StringComparison.Ordinal))
            hubAddress += "/";

        try
        {
            using var cancel = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
            cancel.CancelAfter(TimeSpan.FromSeconds(10));
            var infoTask = GetServerDescriptionAsync(parsedAddress, hubAddress, cancel.Token);
            var statusTask = ServerStatusProbe.FetchAsync(_http, safeAddress, cancel.Token);
            await Task.WhenAll(infoTask, statusTask);
            var info = await infoTask;
            var status = await statusTask;
            if (info == null && status == null)
                throw new WorkerRpcException(new WorkerError("SERVER_INFO_UNAVAILABLE", "Server description and status could not be loaded"));
            if (status != null)
            {
                UpdateServerSnapshot(safeAddress, status);
                if (accountId is { } currentAccount && currentAccount != Guid.Empty)
                {
                    try
                    {
                        if (_recentConnections.RefreshName(currentAccount, safeAddress, status.Name))
                            SendEvent("recentConnections.updated", new { accountId = currentAccount });
                    }
                    catch (Exception error)
                    {
                        // A metadata write must not discard a successful live status.
                        Log.Warning(error, "Could not refresh the recent server name");
                    }
                }
            }
            return new
            {
                description = info?.Desc,
                links = info?.Links?.Select(link => new { name = link.Name, icon = link.Icon, url = link.Url }).ToArray()
                         ?? Array.Empty<object>(),
                name = status?.Name,
                status = status == null ? "offline" : "online",
                playerCount = status?.PlayerCount,
                softMaxPlayerCount = status?.SoftMaxPlayerCount,
                pingMs = status?.PingMs,
                map = status?.Map,
                mode = status?.Mode
            };
        }
        catch (Exception e) when (e is HttpRequestException or IOException or JsonException or TaskCanceledException)
        {
            throw new WorkerRpcException(new WorkerError("SERVER_INFO_UNAVAILABLE", "Server description could not be loaded"));
        }
    }

    private async Task<ServerInfo?> GetServerDescriptionAsync(Uri address, string hubAddress, CancellationToken cancel)
    {
        // A hub may not know this server or index a different trailing-slash
        // spelling. Its /info proxy is a fallback, not a prerequisite for status.
        try
        {
            using var directTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            directTimeout.CancelAfter(ConfigConstants.ServerStatusTimeout);
            var info = await _http.GetFromJsonAsync<ServerInfo>(UriHelper.GetServerInfoAddress(address), directTimeout.Token);
            if (info != null) return info;
        }
        catch (Exception error) when (error is HttpRequestException or IOException or JsonException or OperationCanceledException)
        {
            Log.Debug("Direct server description unavailable ({ErrorType})", error.GetType().Name);
        }

        var lookup = address.AbsoluteUri;
        var alternate = lookup.EndsWith('/') ? lookup.TrimEnd('/') : lookup + "/";
        foreach (var candidate in new[] { lookup, alternate })
        {
            try
            {
                return await _hub.GetServerInfo(candidate, hubAddress, cancel);
            }
            catch (HttpRequestException error) when (error.StatusCode == System.Net.HttpStatusCode.NotFound)
            {
                // Hubs use the registered string as their key. Try the other
                // trailing-slash spelling only when that key was not found.
                Log.Debug("Server description not indexed by hub under this address spelling");
            }
            catch (Exception error) when (error is HttpRequestException or IOException or JsonException or OperationCanceledException)
            {
                Log.Debug("Hub server description unavailable ({ErrorType})", error.GetType().Name);
                return null;
            }
        }
        return null;
    }

    private object GetFavorites()
    {
        return _data.FavoriteServers.Items.Select(f => new
        {
            name = f.Name,
            address = f.Address,
            raiseTime = f.RaiseTime
        }).ToArray();
    }

    private object AddFavorite(JsonElement parameters)
    {
        var address = RequiredString(parameters, "address");
        var name = OptionalString(parameters, "name");
        try
        {
            var key = PersonalData.NormalizeAddress(address) ?? address;
            if (_data.FavoriteServers.Items.Any(f => (PersonalData.NormalizeAddress(f.Address) ?? f.Address) == key))
                throw new ArgumentException("A server with that address is already a favorite.");
            _data.AddFavoriteServer(new FavoriteServer(name, address));
            _data.CommitConfig();
        }
        catch (ArgumentException e)
        {
            throw new WorkerRpcException(new WorkerError("FAVORITE_EXISTS", e.Message));
        }

        return GetFavorites();
    }

    private object RemoveFavorite(JsonElement parameters)
    {
        var address = RequiredString(parameters, "address");
        var key = PersonalData.NormalizeAddress(address) ?? address;
        var favorites = _data.FavoriteServers.Items
            .Where(f => (PersonalData.NormalizeAddress(f.Address) ?? f.Address) == key).ToArray();
        if (favorites.Length == 0)
            throw new WorkerRpcException(new WorkerError("FAVORITE_NOT_FOUND", "Favorite server was not found"));

        foreach (var favorite in favorites)
            _data.RemoveFavoriteServer(favorite);
        _data.CommitConfig();
        return GetFavorites();
    }

    private async Task<object> GetNewsAsync()
    {
        var items = new List<NewsEntry>();

        try
        {
            var feed = await FeedReader.ReadAsync(ConfigConstants.NewsFeedUrl);
            items.AddRange(feed.Items.Select(item => new NewsEntry(
                item.Title ?? "Space Station 14",
                item.Link ?? ConfigConstants.NewsFeedUrl,
                item.PublishingDate,
                "Space Station 14",
                NewsContent.Summary(item.Description), NewsContent.PlainText(item.Content ?? item.Description))));
        }
        catch (Exception error) when (error is HttpRequestException or IOException or JsonException or TaskCanceledException)
        {
            Log.Warning(error, "Official Space Station 14 news feed is unavailable");
        }

        try
        {
            items.AddRange(await GetGitHubNewsAsync());
        }
        catch (Exception error) when (error is HttpRequestException or IOException or JsonException or TaskCanceledException)
        {
            Log.Warning(error, "Mados Launcher GitHub releases are unavailable");
        }

        if (items.Count == 0)
            throw new WorkerRpcException(new WorkerError("NEWS_UNAVAILABLE", "News could not be loaded"));

        return NewsContent.SelectForFeed(items)
            .Select(item => new
            {
                title = item.Title,
                link = item.Link,
                date = item.Date,
                source = item.Source,
                summary = item.Summary,
                body = item.Body,
                version = item.Version,
                prerelease = item.Prerelease
            }).ToArray();
    }

    private async Task<IReadOnlyList<NewsEntry>> GetGitHubNewsAsync()
    {
        // Fetch the stable release independently so previews cannot push it out of the feed.
        var results = await Task.WhenAll(Fetch(ConfigConstants.MadosLauncherGitHubReleasesApi, false),
            Fetch($"https://api.github.com/repos/{ConfigConstants.MadosLauncherGitHubRepository}/releases/latest", true));
        return results.SelectMany(items => items).ToArray();

        async Task<IReadOnlyList<NewsEntry>> Fetch(string url, bool latest)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.Accept.ParseAdd("application/vnd.github+json");
                request.Headers.UserAgent.ParseAdd("Mados.Launcher");
                using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
                if (latest && response.StatusCode == System.Net.HttpStatusCode.NotFound) return Array.Empty<NewsEntry>();
                response.EnsureSuccessStatusCode();
                using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                if (latest)
                {
                    if (document.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException("Expected a GitHub release object");
                    var release = NewsContent.FromGitHub(document.RootElement);
                    return release is { Prerelease: false } ? new[] { release with { IsLatestStable = true } } : Array.Empty<NewsEntry>();
                }
                if (document.RootElement.ValueKind != JsonValueKind.Array) throw new JsonException("Expected a GitHub releases array");
                return document.RootElement.EnumerateArray().Select(NewsContent.FromGitHub).Where(item => item != null).Cast<NewsEntry>().ToArray();
            }
            catch (Exception error) when (error is HttpRequestException or IOException or JsonException or TaskCanceledException)
            {
                Log.Warning(error, "GitHub news source unavailable (latest stable: {Latest})", latest);
                return Array.Empty<NewsEntry>();
            }
        }
    }
    private object GetSettings()
    {
        return new
        {
            compatMode = _data.GetCVar(CVars.CompatMode),
            verboseLogging = _data.GetCVar(CVars.LogLauncherVerbose),
            overrideAssets = _data.GetCVar(CVars.OverrideAssets),
            language = _data.GetCVar(CVars.Language),
            multiAccounts = _data.ActuallyMultiAccounts,
            accountManagementUrl = ConfigConstants.AccountManagementUrl,
            registerUrl = ConfigConstants.AccountRegisterUrl,
            discordUrl = ConfigConstants.DiscordUrl,
            websiteUrl = ConfigConstants.WebsiteUrl,
            discordPresenceEnabled = _data.GetCVar(CVars.DiscordPresenceEnabled),
            discordPresenceShowNickname = _data.GetCVar(CVars.DiscordPresenceShowNickname),
            favoriteAvailabilityNotifications = _data.GetCVar(CVars.FavoriteAvailabilityNotifications)
            ,minimizeOnPlay = _data.GetCVar(CVars.MinimizeOnPlay)
            ,restoreAfterPlay = _data.GetCVar(CVars.RestoreAfterPlay)
        };
    }

    private object GetDiscordSettings()
    {
        return new
        {
            enabled = _data.GetCVar(CVars.DiscordPresenceEnabled),
            showNickname = _data.GetCVar(CVars.DiscordPresenceShowNickname)
        };
    }

    private object UpdateSettings(JsonElement parameters)
    {
        if(TryGetProperty(parameters,"minimizeOnPlay",out var minimize))_data.SetCVar(CVars.MinimizeOnPlay,minimize.GetBoolean());
        if(TryGetProperty(parameters,"restoreAfterPlay",out var restore))_data.SetCVar(CVars.RestoreAfterPlay,restore.GetBoolean());
        if (TryGetProperty(parameters, "compatMode", out var compatMode))
            _data.SetCVar(CVars.CompatMode, compatMode.GetBoolean());
        if (TryGetProperty(parameters, "verboseLogging", out var verboseLogging))
            _data.SetCVar(CVars.LogLauncherVerbose, verboseLogging.GetBoolean());
        if (TryGetProperty(parameters, "overrideAssets", out var overrideAssets))
            _data.SetCVar(CVars.OverrideAssets, overrideAssets.GetBoolean());
        if (TryGetProperty(parameters, "discordPresenceEnabled", out var discordPresenceEnabled))
            _data.SetCVar(CVars.DiscordPresenceEnabled, discordPresenceEnabled.GetBoolean());
        if (TryGetProperty(parameters, "discordPresenceShowNickname", out var discordPresenceShowNickname))
            _data.SetCVar(CVars.DiscordPresenceShowNickname, discordPresenceShowNickname.GetBoolean());
        if (TryGetProperty(parameters, "favoriteAvailabilityNotifications", out var favoriteAvailabilityNotifications))
            _data.SetCVar(CVars.FavoriteAvailabilityNotifications, favoriteAvailabilityNotifications.GetBoolean());
        if (TryGetProperty(parameters, "language", out var language))
            _data.SetCVar(CVars.Language, language.ValueKind == JsonValueKind.Null ? null : language.GetString());
        if (TryGetProperty(parameters, "dismissEarlyAccess", out var dismissEarlyAccess) && dismissEarlyAccess.GetBoolean())
            _data.SetCVar(CVars.HasDismissedEarlyAccessWarning, true);
        if (TryGetProperty(parameters, "dismissIntelDegradation", out var dismissIntel) && dismissIntel.GetBoolean())
            _data.SetCVar(CVars.HasDismissedIntelDegradation, true);
        if (TryGetProperty(parameters, "dismissRosetta", out var dismissRosetta) && dismissRosetta.GetBoolean())
            _data.SetCVar(CVars.HasDismissedRosettaWarning, true);

        _data.CommitConfig();
        SendEvent("settings.changed", new { discord = GetDiscordSettings(), window=GetWindowSettings(), favoriteAvailabilityNotifications = _data.GetCVar(CVars.FavoriteAvailabilityNotifications) });
        ConfigurePresence();
        return GetSettings();
    }

    private object GetPlaytimeSummary(JsonElement parameters)
    {
        var period = OptionalString(parameters, "period")?.ToLowerInvariant() switch
        {
            null or "all" => PlaytimePeriod.All,
            "today" => PlaytimePeriod.Today,
            "sevendays" or "seven_days" or "7d" => PlaytimePeriod.SevenDays,
            _ => throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", "Unknown playtime period"))
        };

        var accountId = _login.ActiveAccountId;
        var summary = _playtimeStore.GetSummary(accountId ?? Guid.Empty, period, DateTimeOffset.UtcNow);
        return new
        {
            accountId = summary.AccountId,
            period = period switch
            {
                PlaytimePeriod.Today => "today",
                PlaytimePeriod.SevenDays => "sevenDays",
                _ => "all"
            },
            trackedSince = summary.TrackedSince,
            generatedAt = summary.GeneratedAt,
            dailyActivity = summary.DailyActivity.Select(day => new { date = day.Date, totalSeconds = day.TotalSeconds }).ToArray(),
            totalSeconds = summary.TotalSeconds,
            sessionCount = summary.SessionCount,
            uniqueServers = summary.UniqueServers,
            activeSession = summary.ActiveSession is { } active
                ? new { address = active.Address, name = active.Name, startedAt = active.StartedAt, elapsedSeconds = active.ElapsedSeconds }
                : null,
            servers = summary.Servers.Select(server => new
            {
                address = server.Address,
                name = server.Name,
                totalSeconds = server.TotalSeconds,
                sessionCount = server.SessionCount,
                lastPlayedAt = server.LastPlayedAt,
                active = server.Active
            }).ToArray()
        };
    }

    private object ClearPlaytime()
    {
        var accountId = _login.ActiveAccountId;
        if (accountId is null)
            throw new WorkerRpcException(new WorkerError("AUTH_REQUIRED", "An active account is required"));

        var removed = _playtimeStore.ClearCompleted(accountId.Value);
        SendEvent("playtime.updated", new { accountId, cleared = removed });
        return new { removed };
    }

    private object ListRecentConnections(JsonElement parameters)
    {
        if (_login.ActiveAccountId is not { } accountId || accountId == Guid.Empty)
            throw new WorkerRpcException(new WorkerError("AUTH_REQUIRED", "An active account is required for recent connections"));

        var limit = OptionalInt(parameters, "limit") ?? RecentConnectionStore.DefaultLimit;
        try
        {
            return _recentConnections.List(accountId, limit).Select(ToRecentConnectionDto).ToArray();
        }
        catch (ArgumentOutOfRangeException error)
        {
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", error.Message));
        }
        catch (ArgumentException error)
        {
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", error.Message));
        }
    }

    private static object ToRecentConnectionDto(RecentConnection connection)
        => new
        {
            address = connection.Address,
            name = connection.Name,
            lastConnectedAt = connection.LastConnectedAt,
            playerCount = connection.PlayerCount,
            pingMs = connection.PingMs
        };

    private object ListServerNotes()
    {
        var accountId = RequireActiveAccountForNotes();
        return _serverNotes.List(accountId).Select(ToServerNoteDto).ToArray();
    }

    private object? UpsertServerNote(JsonElement parameters)
    {
        var accountId = RequireActiveAccountForNotes();
        var address = RequiredString(parameters, "address");
        var text = NoteTextParameter(parameters);
        try
        {
            var note = _serverNotes.Upsert(accountId, address, text);
            return note is null ? null : ToServerNoteDto(note);
        }
        catch (ArgumentException error)
        {
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", error.Message));
        }
    }

    private object RemoveServerNote(JsonElement parameters)
    {
        var accountId = RequireActiveAccountForNotes();
        var address = RequiredString(parameters, "address");
        try
        {
            return new { removed = _serverNotes.Remove(accountId, address) };
        }
        catch (ArgumentException error)
        {
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", error.Message));
        }
    }

    private Guid RequireActiveAccountForNotes()
    {
        if (_login.ActiveAccountId is not { } accountId || accountId == Guid.Empty)
            throw new WorkerRpcException(new WorkerError("AUTH_REQUIRED", "An active account is required for server notes"));
        return accountId;
    }

    private static object ToServerNoteDto(ServerNote note)
        => new { address = note.Address, text = note.Text, updatedAt = note.UpdatedAtUtc };

    private object GetMonitoringFavorites()
    {
        var accountId = RequireActiveInsightsAccount();
        var favorites = _data.FavoriteServers.Items.Select(f => new FavoriteMonitorTarget(f.Address, f.Name));
        return new
        {
            accountId,
            favorites = _insights.GetFavoriteSummaries(accountId, favorites).Select(ToFavoriteMonitorDto).ToArray()
        };
    }

    private Task<object> RefreshMonitoringAsync()
    {
        var accountId = RequireActiveInsightsAccount();
        var favoriteTargets = _data.FavoriteServers.Items
            .Select(f => new FavoriteMonitorTarget(f.Address, f.Name))
            .ToArray();
        var notify = _data.GetCVar(CVars.FavoriteAvailabilityNotifications);
        return _monitoringQueue.RunAsync(() => RefreshMonitoringCoreAsync(accountId, favoriteTargets, notify), _shutdown.Token);
    }

    private async Task<object> RefreshMonitoringCoreAsync(Guid accountId, FavoriteMonitorTarget[] favoriteTargets,
        bool notify, IEnumerable<ServerCatalogEntry>? catalog = null)
    {
        var catalogByAddress = catalog?
            .Select(server => (server, address: LauncherInsightsStore.NormalizeAddress(server.Address)))
            .GroupBy(item => item.address, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.First().server, StringComparer.OrdinalIgnoreCase);
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
        cancel.CancelAfter(TimeSpan.FromSeconds(15));

        foreach (var favorite in favoriteTargets)
        {
            _shutdown.Token.ThrowIfCancellationRequested();
            string normalizedAddress;
            try
            {
                normalizedAddress = LauncherInsightsStore.NormalizeAddress(favorite.Address);
            }
            catch (ArgumentException)
            {
                continue;
            }

            ServerStatusSnapshot? snapshot = null;
            if (catalogByAddress is not null && catalogByAddress.TryGetValue(normalizedAddress, out var listed))
            {
                snapshot = new ServerStatusSnapshot(listed.Name, listed.PlayerCount, listed.SoftMaxPlayerCount, listed.RoundStartTime, listed.RunLevel, listed.Tags, listed.PingMs, listed.Language, listed.Map, listed.Mode);
            }
            else if (catalog is null)
            {
                snapshot = GetServerSnapshot(normalizedAddress);
            }

            // A direct probe is only needed when the manual refresh did not
            // receive this favorite from the hub. This also covers favorites
            // hidden by hub filters or temporarily absent from the catalog.
            if (snapshot is null)
                snapshot = await ServerStatusProbe.FetchAsync(_http, normalizedAddress, cancel.Token);

            var write = _insights.RecordSample(
                accountId,
                new MonitorSample(
                    normalizedAddress,
                    snapshot?.Name ?? favorite.Name,
                    snapshot is not null,
                    snapshot?.PlayerCount,
                    snapshot?.SoftMaxPlayerCount,
                    snapshot?.PingMs,
                    snapshot?.Map,
                    snapshot?.Mode),
                notify);
            if (write.Notification is { } notification && _login.ActiveAccountId == accountId)
            {
                SendEvent("notification.created", ToNotificationDto(notification));
            }
        }

        var result = new
        {
            accountId,
            favorites = _insights.GetFavoriteSummaries(accountId, favoriteTargets).Select(ToFavoriteMonitorDto).ToArray()
        };
        if (_login.ActiveAccountId == accountId) SendEvent("monitoring.updated", result);
        return result;
    }

    private object ListLaunchProfiles()
    {
        var accountId = RequireActiveInsightsAccount();
        return _insights.ListProfiles(accountId).Select(ToLaunchProfileDto).ToArray();
    }

    private object CreateLaunchProfile(JsonElement parameters)
    {
        var accountId = RequireActiveInsightsAccount();
        try
        {
            var profile = _insights.CreateProfile(accountId, RequiredString(parameters, "name"), RequiredString(parameters, "address"));
            SendEvent("launchProfiles.updated", new { accountId });
            return ToLaunchProfileDto(profile);
        }
        catch (ArgumentException error)
        {
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", error.Message));
        }
    }

    private object UpdateLaunchProfile(JsonElement parameters)
    {
        var accountId = RequireActiveInsightsAccount();
        try
        {
            var profile = _insights.UpdateProfile(accountId, RequiredString(parameters, "id"), RequiredString(parameters, "name"), RequiredString(parameters, "address"));
            SendEvent("launchProfiles.updated", new { accountId });
            return ToLaunchProfileDto(profile);
        }
        catch (KeyNotFoundException error)
        {
            throw new WorkerRpcException(new WorkerError("PROFILE_NOT_FOUND", error.Message));
        }
        catch (ArgumentException error)
        {
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", error.Message));
        }
    }

    private object RemoveLaunchProfile(JsonElement parameters)
    {
        var accountId = RequireActiveInsightsAccount();
        try
        {
            var removed = _insights.RemoveProfile(accountId, RequiredString(parameters, "id"));
            if (removed)
                SendEvent("launchProfiles.updated", new { accountId });
            return new { removed };
        }
        catch (ArgumentException error)
        {
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", error.Message));
        }
    }

    private object UseLaunchProfile(JsonElement parameters)
    {
        var accountId = RequireActiveInsightsAccount();
        try
        {
            var profile = _insights.UseProfile(accountId, RequiredString(parameters, "id"));
            SendEvent("launchProfiles.updated", new { accountId });
            return ToLaunchProfileDto(profile);
        }
        catch (KeyNotFoundException error)
        {
            throw new WorkerRpcException(new WorkerError("PROFILE_NOT_FOUND", error.Message));
        }
        catch (ArgumentException error)
        {
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", error.Message));
        }
    }

    private object ListNotifications()
    {
        var accountId = RequireActiveInsightsAccount();
        return _insights.ListNotifications(accountId).Select(ToNotificationDto).ToArray();
    }

    private object MarkNotificationRead(JsonElement parameters)
    {
        var accountId = RequireActiveInsightsAccount();
        try
        {
            return new { marked = _insights.MarkNotificationRead(accountId, RequiredString(parameters, "id")) };
        }
        catch (ArgumentException error)
        {
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", error.Message));
        }
    }

    private object ClearNotifications()
    {
        var accountId = RequireActiveInsightsAccount();
        return new { removed = _insights.ClearNotifications(accountId) };
    }

    private async Task<object> InspectCdnAsync(JsonElement parameters)
    {
        try
        {
            var source = OptionalString(parameters, "sourceUrl") ?? OptionalString(parameters, "source")
                ?? throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", "Parameter 'sourceUrl' is required"));
            var result = await _localServers.InspectAsync(source, _shutdown.Token);
            return ToCdnInspectDto(result);
        }
        catch (LocalServerException error)
        {
            SendEvent("cdn.failed", new { code = error.Code, message = error.Message });
            throw new WorkerRpcException(new WorkerError(error.Code, error.Message));
        }
        catch (HttpRequestException error)
        {
            SendEvent("cdn.failed", new { code = "CDN_UNAVAILABLE", message = error.Message });
            throw new WorkerRpcException(new WorkerError("CDN_UNAVAILABLE", error.Message));
        }
    }

    private async Task<object> ImportCdnAsync(JsonElement parameters)
    {
        var source = OptionalString(parameters, "localPath") ?? OptionalString(parameters, "sourceUrl") ?? OptionalString(parameters, "source");
        if (string.IsNullOrWhiteSpace(source))
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", "Parameter 'sourceUrl' or 'localPath' is required"));
        var operationId = RequiredString(parameters, "operationId");
        if (!Guid.TryParse(operationId, out _))
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", "Operation identifier must be a UUID"));
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
        lock (_cdnLock)
        {
            if (_cdnCancellation is not null)
                throw new WorkerRpcException(new WorkerError("CDN_BUSY", "Дождитесь завершения текущей установки."));
            _cdnCancellation = cancellation;
            _cdnOperationId = operationId;
        }
        try
        {
            SendEvent("cdn.progress", new { operationId, stage = "inspecting", percent = (double?)null, message = "Проверяем сборку…" });
            var inspection = await _localServers.InspectAsync(source, cancellation.Token);
            var buildId = OptionalString(parameters, "buildId");
            var selectedUrl = buildId is null ? null : inspection.Variants.FirstOrDefault(v => string.Equals(v.Url, buildId, StringComparison.OrdinalIgnoreCase))?.Url;
            if (buildId is not null && selectedUrl is null)
                throw new LocalServerException("BUILD_NOT_FOUND", "Выбранная сборка не найдена.");
            SendEvent("cdn.progress", new { operationId, stage = "downloading", percent = 0d, message = "Скачиваем сборку…" });
            var profile = await _localServers.ImportAsync(
                source,
                selectedUrl,
                OptionalString(parameters, "profileId"),
                OptionalString(parameters, "profileName") ?? OptionalString(parameters, "name"),
                OptionalInt(parameters, "port"),
                cancellation.Token);
            SendEvent("cdn.progress", new { operationId, stage = "completed", percent = 100d, message = "Сборка установлена" });
            SendEvent("cdn.completed", new { operationId, profileId = profile.Id });
            return new { operationId, profile = ToLocalServerDto(profile) };
        }
        catch (LocalServerException error)
        {
            SendEvent("cdn.failed", new { operationId, code = error.Code, message = error.Message });
            throw new WorkerRpcException(new WorkerError(error.Code, error.Message));
        }
        catch (IOException error)
        {
            SendEvent("cdn.failed", new { operationId, code = "LOCAL_SERVER_IO", message = error.Message });
            throw new WorkerRpcException(new WorkerError("LOCAL_SERVER_IO", error.Message));
        }
        catch (OperationCanceledException)
        {
            SendEvent("cdn.progress", new { operationId, stage = "cancelled", percent = (double?)null, message = "Установка отменена" });
            throw;
        }
        catch (HttpRequestException)
        {
            SendEvent("cdn.failed", new { operationId, message = "Не удалось скачать сборку. Проверьте подключение и повторите." });
            throw new WorkerRpcException(new WorkerError("CDN_UNAVAILABLE", "Не удалось скачать сборку. Проверьте подключение и повторите."));
        }
        finally
        {
            lock (_cdnLock)
            {
                _cdnCancellation = null;
                _cdnOperationId = null;
            }
        }
    }

    private object CancelCdn(JsonElement parameters)
    {
        var operationId = RequiredString(parameters, "operationId");
        lock (_cdnLock)
        {
            var active = _cdnOperationId == operationId && _cdnCancellation is not null;
            if (active) _cdnCancellation!.Cancel();
            return new { cancelled = active };
        }
    }

    private object ListLocalServers() => _localServers.ListProfiles().Select(ToLocalServerDto).ToArray();

    private async Task<object> CreateLocalServerAsync(JsonElement parameters)
    {
        // Creation is an import in the public protocol. Keeping this alias
        // avoids a second code path that could bypass archive validation.
        return await ImportCdnAsync(parameters);
    }

    private object UpdateLocalServer(JsonElement parameters)
    {
        try
        {
            var profile = _localServers.UpdateProfileSettings(
                RequiredString(parameters, "id"), OptionalString(parameters, "name"), OptionalInt(parameters, "port"), OptionalString(parameters, "bindAddress"));
            return ToLocalServerDto(profile);
        }
        catch (LocalServerException error)
        {
            throw new WorkerRpcException(new WorkerError(error.Code, error.Message));
        }
    }

    private async Task<object> RemoveLocalServerAsync(JsonElement parameters)
    {
        try
        {
            return new { removed = await _localServers.RemoveProfileAsync(RequiredString(parameters, "id"), _shutdown.Token) };
        }
        catch (LocalServerException error)
        {
            throw new WorkerRpcException(new WorkerError(error.Code, error.Message));
        }
    }

    private async Task<object> StartLocalServerAsync(JsonElement parameters)
    {
        try
        {
            _localLaunchingAccount = _login.ActiveAccountId;
            return ToLocalServerStatusDto(await _localServers.StartAsync(RequiredString(parameters, "id"), _shutdown.Token));
        }
        catch (LocalServerException error)
        {
            throw new WorkerRpcException(new WorkerError(error.Code, error.Message));
        }
    }

    private async Task<object> StopLocalServerAsync(JsonElement parameters)
    {
        try
        {
            return ToLocalServerStatusDto(await _localServers.StopAsync(OptionalString(parameters, "id"), _shutdown.Token));
        }
        catch (LocalServerException error)
        {
            throw new WorkerRpcException(new WorkerError(error.Code, error.Message));
        }
    }

    private async Task<object> RestartLocalServerAsync(JsonElement parameters)
    {
        try
        {
            _localLaunchingAccount = _login.ActiveAccountId;
            return ToLocalServerStatusDto(await _localServers.RestartAsync(RequiredString(parameters, "id"), _shutdown.Token));
        }
        catch (LocalServerException error)
        {
            throw new WorkerRpcException(new WorkerError(error.Code, error.Message));
        }
    }

    private object GetLocalServerStatus(JsonElement parameters)
    {
        var requestedId = OptionalString(parameters, "id");
        var runtime = _localServers.GetStatus();
        if (requestedId is not null && runtime.ProfileId != requestedId)
        {
            var profile = _localServers.ListProfiles().FirstOrDefault(item => item.Id == requestedId);
            return ToLocalServerStatusDto(new LocalServerRuntimeStatus(LocalServerStatus.Idle, requestedId, null, null, null, profile?.Port));
        }
        return ToLocalServerStatusDto(runtime);
    }

    private async Task<object> GetLocalServerConfigAsync(JsonElement parameters)
    {
        try
        {
            var id = RequiredString(parameters, "id");
            return await _localServers.GetConfigurationAsync(id, _shutdown.Token);
        }
        catch (LocalServerException error) { throw new WorkerRpcException(new WorkerError(error.Code, error.Message)); }
    }

    private async Task<object> SaveLocalServerConfigAsync(JsonElement parameters)
    {
        try
        {
            var id = RequiredString(parameters, "id");
            var config = TryGetProperty(parameters, "config", out var configElement) && configElement.ValueKind == JsonValueKind.Object ? configElement : parameters;
            var input = new LocalServerConfiguration(
                OptionalString(config, "name"),
                OptionalString(config, "hostname"),
                OptionalString(config, "bindAddress") ?? LocalServerManager.DefaultBindAddress,
                OptionalInt(config, "port") ?? LocalServerManager.DefaultPort,
                OptionalInt(config, "maxPlayers"),
                OptionalString(config, "authMode"),
                OptionalString(config, "rawToml") ?? string.Empty);
            var mode = RequiredString(parameters, "mode");
            if (mode == "raw")
            {
                await _localServers.SaveConfigAsync(id, input.RawToml, _shutdown.Token);
                return await _localServers.GetConfigurationAsync(id, _shutdown.Token);
            }
            if (mode != "fields") throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", "Invalid config mode"));
            return await _localServers.SaveConfigurationAsync(id, input, _shutdown.Token);
        }
        catch (LocalServerException error) { throw new WorkerRpcException(new WorkerError(error.Code, error.Message)); }
    }

    private object TestLocalServerPort(JsonElement parameters)
    {
        var port = OptionalInt(parameters, "port") ?? LocalServerManager.DefaultPort;
        var bind = OptionalString(parameters, "bindAddress") ?? LocalServerManager.DefaultBindAddress;
        LocalServerConfig.ValidatePort(port);
        LocalServerConfig.ValidateBind(bind);
        return new { address = bind, available = LocalServerManager.IsPortAvailable(bind, port), error = (string?)null, port };
    }

    private object OpenLocalServerFolder(JsonElement parameters)
    {
        var profile = _localServers.ListProfiles().FirstOrDefault(p => p.Id == RequiredString(parameters, "id"))
            ?? throw new WorkerRpcException(new WorkerError("PROFILE_NOT_FOUND", "Локальный профиль не найден."));
        return new { path = profile.InstallPath };
    }

    private object OpenLocalServerLog(JsonElement parameters)
    {
        try
        {
            var path = _localServers.GetLogPath(RequiredString(parameters, "id"));
            return new { path };
        }
        catch (LocalServerException error) { throw new WorkerRpcException(new WorkerError(error.Code, error.Message)); }
    }

    private object ListLocalServerBackups(JsonElement parameters)
    {
        try
        {
            return _localServers.ListBackups(RequiredString(parameters, "id")).Select(backup => new
            {
                id = backup.Id,
                profileId = backup.ProfileId,
                createdAt = backup.CreatedAtUtc,
                reason = backup.Reason
            }).ToArray();
        }
        catch (LocalServerException error) { throw new WorkerRpcException(new WorkerError(error.Code, error.Message)); }
    }

    private async Task<object> RollbackLocalServerAsync(JsonElement parameters)
    {
        try
        {
            var id = RequiredString(parameters, "id");
            await _localServers.RollbackAsync(id, RequiredString(parameters, "backupId"), _shutdown.Token);
            var profile = _localServers.ListProfiles().First(item => item.Id == id);
            return ToLocalServerDto(profile);
        }
        catch (LocalServerException error) { throw new WorkerRpcException(new WorkerError(error.Code, error.Message)); }
    }

    private static object ToCdnInspectDto(CdnInspectResult result)
    {
        var builds = result.Variants.Select(v => new
        {
            id = v.Url,
            version = v.Version,
            platform = v.Platform,
            architecture = v.Architecture,
            downloadUrl = v.Url,
            sizeBytes = v.SizeBytes,
            publishedAt = v.PublishedAt
        }).ToArray();
        var platform = OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : "linux";
        var architecture = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture == System.Runtime.InteropServices.Architecture.Arm64 ? "arm64" : "x64";
        var recommended = builds.FirstOrDefault(v => string.Equals(v.platform, platform, StringComparison.OrdinalIgnoreCase)
            && string.Equals(v.architecture, architecture, StringComparison.OrdinalIgnoreCase))?.id
            ?? (builds.Length == 1 && builds[0].platform is null && builds[0].architecture is null ? builds[0].id : null);
        return new
        {
            sourceUrl = result.Source,
            sourceType = string.Equals(result.Kind, "zip", StringComparison.OrdinalIgnoreCase) ? "zip" : "robust-cdn",
            builds,
            recommendedBuildId = recommended
        };
    }

    private static object ToLocalServerDto(LocalServerProfile profile) => new
    {
        id = profile.Id,
        name = profile.Name,
        sourceUrl = profile.SourceUrl,
        installPath = profile.InstallPath,
        version = profile.Version,
        platform = profile.Platform,
        architecture = profile.Architecture,
        port = profile.Port,
        bindAddress = profile.BindAddress,
        dataPath = profile.DataPath,
        configPath = profile.ConfigPath,
        createdAt = profile.CreatedAtUtc,
        updatedAt = profile.UpdatedAtUtc,
        lastStartedAt = profile.LastStartedAtUtc
    };

    private static object ToLocalServerStatusDto(LocalServerRuntimeStatus status) => new
    {
        status = status.Status.ToString().ToLowerInvariant(),
        profileId = status.ProfileId,
        pid = status.Pid,
        address = $"ss14://{LocalServerManager.DefaultBindAddress}:{status.Port ?? LocalServerManager.DefaultPort}",
        port = status.Port ?? LocalServerManager.DefaultPort,
        readyAt = status.Status == LocalServerStatus.Running ? status.StartedAt : null,
        lastError = status.Error
    };

    private void LocalServerOnChanged(LocalServerEvent value)
    {
        if (value.Kind == "log")
            SendEvent("localServer.log", new { profileId = value.ProfileId, timestamp = DateTimeOffset.UtcNow, stream = value.Stream, line = value.Message });
        else if (value.Kind == "configChanged")
            SendEvent("localServer.configChanged", new { profileId = value.ProfileId });
        else if (value.Status is { } status)
        {
            var port = value.Port ?? LocalServerManager.DefaultPort;
            var address = $"ss14://{LocalServerManager.DefaultBindAddress}:{port}";
            SendEvent("localServer.status", new
            {
                profileId = value.ProfileId,
                status = status.ToString().ToLowerInvariant(),
                pid = value.Pid,
                address,
                port,
                readyAt = status == LocalServerStatus.Running ? value.StartedAt : null,
                lastError = value.Message
            });
            if (status == LocalServerStatus.Running && value.ProfileId is { Length: > 0 } profileId
                && _localLaunchingAccount is { } accountId)
            {
                try
                {
                    var localProfile = _localServers.ListProfiles().FirstOrDefault(profile => profile.Id == profileId);
                    if (localProfile is not null)
                    {
                        if (!_insights.ListProfiles(accountId).Any(item => item.Address.TrimEnd('/') == address.TrimEnd('/')))
                        {
                            _insights.CreateProfile(accountId, localProfile.Name, address);
                            SendEvent("launchProfiles.updated", new { accountId });
                        }
                    }
                }
                catch (Exception error)
                {
                    Log.Warning(error, "Could not create a launch profile for local server");
                }
            }
            if (status == LocalServerStatus.Error)
                SendEvent("localServer.error", new { profileId = value.ProfileId, message = value.Message });
        }
        else if (value.Kind != "ready")
        {
            string? operationId;
            lock (_cdnLock) operationId = _cdnOperationId;
            if (operationId is not null)
                SendEvent("cdn.progress", new { operationId, stage = value.Kind, percent = value.Progress is { } amount ? (double?)Math.Round(amount * 100, 1) : null, downloadedBytes = (long?)null, totalBytes = (long?)null, message = value.Message ?? (value.Kind == "extracting" ? "Распаковываем сборку…" : "Скачиваем сборку…") });
        }
    }

    private Guid RequireActiveInsightsAccount()
    {
        if (_login.ActiveAccountId is not { } accountId || accountId == Guid.Empty)
            throw new WorkerRpcException(new WorkerError("AUTH_REQUIRED", "An active account is required"));
        return accountId;
    }

    private static object ToFavoriteMonitorDto(FavoriteMonitorSummary summary)
        => new
        {
            address = summary.Address,
            name = summary.Name,
            isOnline = summary.IsOnline,
            playerCount = summary.PlayerCount,
            softMaxPlayerCount = summary.SoftMaxPlayerCount,
            pingMs = summary.PingMs,
            pingDeltaMs = summary.PingDeltaMs,
            playerDelta = summary.PlayerDelta,
            samples = summary.Samples.Select(sample => new { capturedAt = sample.CapturedAt, isOnline = sample.IsOnline, pingMs = sample.PingMs, playerCount = sample.PlayerCount }).ToArray()
        };

    private static object ToLaunchProfileDto(LaunchProfile profile)
        => new { id = profile.Id, address = profile.Address, name = profile.Name, createdAt = profile.CreatedAtUtc, lastUsedAt = profile.LastUsedAtUtc };

    private static object ToNotificationDto(LauncherNotification notification)
        => new { id = notification.Id, kind = notification.Kind, title = notification.Title, message = notification.Message, createdAt = notification.CreatedAtUtc, readAt = notification.ReadAtUtc, address = notification.Address, accountId = notification.AccountId };

    private object StartConnection(JsonElement parameters)
    {
        EnsureCacheReadyForLaunch();
        StopSeatWatch();
        using var storageLease=_maintenanceGate.Use();
        var address = RequiredString(parameters, "address");
        var reason = OptionalString(parameters, "reason");
        var requestedName = OptionalString(parameters, "name");
        var snapshot = GetServerSnapshot(address);
        // A fresh status also replaces names damaged by older stdio encodings.
        var serverName = string.IsNullOrWhiteSpace(snapshot?.Name) ? requestedName : snapshot.Name;
        if (_connectionTask is { IsCompleted: false })
            throw new WorkerRpcException(new WorkerError("CONNECTION_BUSY", "A connection is already in progress"));

        _presence.Prepare(address, serverName, _login.ActiveAccount?.Username, snapshot);
        _playtimeTracker.Prepare(_login.ActiveAccountId, PresenceAddress.Sanitize(address) ?? address, serverName, countable: true);
        _pendingRecentConnection = _login.ActiveAccountId is { } accountId && accountId != Guid.Empty
            ? new PendingRecentConnection(accountId, PresenceAddress.Sanitize(address) ?? address, serverName, snapshot)
            : null;
        _connectionCancellation?.Dispose();
        _connectionCancellation = new CancellationTokenSource();
        _connectionTask = ObserveConnectionAsync(address, reason, _connectionCancellation.Token, serverName);
        return new { started = true, address = PresenceAddress.Sanitize(address), reason, name = serverName };
    }

    private async Task ObserveConnectionAsync(string address, string? reason, CancellationToken cancel, string? serverName = null)
    {
        SendEvent("connection.started", new { address = PresenceAddress.Sanitize(address), name = serverName, reason });
        try
        {
            await _connector.ConnectAsync(address, cancel);
            SendConnectionTerminalEvent(address);
        }
        catch (Exception error)
        {
            Log.Error(error, "Unhandled connection failure");
            _presence.ObserveStatus(Connector.ConnectionStatus.ConnectionFailed);
            SendEvent("connection.failed", new { target = PresenceAddress.Sanitize(address), status = "ConnectionFailed", message = "The connection could not be completed" });
        }
    }

    private object CancelConnection()
    {
        _connectionCancellation?.Cancel();
        _presence.ObserveStatus(Connector.ConnectionStatus.Cancelled);
        return new { cancelled = true };
    }

    private object ConfirmPrivacyPolicy(JsonElement parameters)
    {
        var accepted = parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("accepted", out var value)
            || value.GetBoolean();
        _connector.ConfirmPrivacyPolicy(accepted
            ? PrivacyPolicyAcceptResult.Accepted
            : PrivacyPolicyAcceptResult.Denied);
        return new { accepted };
    }

    private object StartContentBundle(JsonElement parameters)
    {
        EnsureCacheReadyForLaunch();
        StopSeatWatch();
        using var storageLease=_maintenanceGate.Use();
        var path = RequiredString(parameters, "path");
        if (!File.Exists(path) || !string.Equals(Path.GetExtension(path), ".zip", StringComparison.OrdinalIgnoreCase))
            throw new WorkerRpcException(new WorkerError("INVALID_CONTENT_BUNDLE", "The selected file is not a readable .zip"));
        if (_connectionTask is { IsCompleted: false })
            throw new WorkerRpcException(new WorkerError("CONNECTION_BUSY", "A connection is already in progress"));

        _presence.Prepare(null, null, null);
        _playtimeTracker.Prepare(null, path, null, countable: false);
        _pendingRecentConnection = null;
        _connectionCancellation?.Dispose();
        _connectionCancellation = new CancellationTokenSource();
        _connectionTask = ObserveContentBundleAsync(path, _connectionCancellation.Token);
        return new { started = true, path };
    }

    private async Task ObserveContentBundleAsync(string path, CancellationToken cancel)
    {
        SendEvent("connection.started", new { path = Path.GetFileName(path), contentBundle = true });
        try
        {
            await _connector.LaunchContentBundlePathAsync(path, cancel);
            SendConnectionTerminalEvent(path);
        }
        catch (Exception error)
        {
            Log.Error(error, "Unhandled content bundle failure");
            _presence.ObserveStatus(Connector.ConnectionStatus.ConnectionFailed);
            SendEvent("connection.failed", new { target = Path.GetFileName(path), status = "ConnectionFailed", message = "The content bundle could not be opened" });
        }
    }

    private void SendConnectionTerminalEvent(string target)
    {
        var status = _connector.Status;
        var failed = status is Connector.ConnectionStatus.ConnectionFailed
            or Connector.ConnectionStatus.UpdateError
            or Connector.ConnectionStatus.NotAContentBundle;
        SendEvent(failed ? "connection.failed" : "connection.completed", new
        {
            target = PresenceAddress.Sanitize(target),
            status = status.ToString(),
            message = failed ? "The connection could not be completed" : null
        });
    }

    private async Task<object> OpenDeepLinkAsync(JsonElement parameters)
    {
        var uri = RequiredString(parameters, "uri");
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed))
            throw new WorkerRpcException(new WorkerError("INVALID_DEEP_LINK", "The URI is invalid"));

        if (!string.Equals(parsed.Scheme, "ss14", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(parsed.Scheme, "ss14s", StringComparison.OrdinalIgnoreCase))
            throw new WorkerRpcException(new WorkerError("UNSUPPORTED_DEEP_LINK", "Only ss14:// and ss14s:// links are supported"));

        SendEvent("deepLink.received", new { uri = PresenceAddress.Sanitize(uri) });
        StartConnection(JsonSerializer.SerializeToElement(new { address = uri }, JsonOptions));
        return new { accepted = true, uri = PresenceAddress.Sanitize(uri) };
    }

    private object GetUpdateStatus()
    {
        return new { currentVersion = LauncherVersion.Version?.ToString() ?? "unknown", outOfDate = false,
            allowedVersions = Array.Empty<string>(), managedBy = "electron", source = "github" };
    }

    private object StartUpdate(JsonElement parameters)
    {
        // Content updates require a server build manifest. Starting the update
        // through the same connector path keeps the existing updater, cache,
        // engine and progress events authoritative instead of inventing a
        // second update implementation in the worker.
        var address = RequiredString(parameters, "address");
        return StartConnection(JsonSerializer.SerializeToElement(new { address }, JsonOptions));
    }

    private object Shutdown()
    {
        _presence.Dispose();
        _playtimeTracker.Stop();
        _shutdown.Cancel();
        return new { shuttingDown = true };
    }

    private static int? OptionalInt(JsonElement parameters, string property)
    {
        if (!TryGetProperty(parameters, property, out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var parsed))
            return parsed;
        throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", $"Parameter '{property}' must be an integer"));
    }

    private ServerStatusSnapshot? GetServerSnapshot(string address)
    {
        lock (_serverSnapshotLock)
            return _serverSnapshots.TryGetValue(PresenceAddress.Sanitize(address) ?? address, out var snapshot) ? snapshot : null;
    }

    private void UpdateServerSnapshot(string address, ServerStatusSnapshot snapshot)
    {
        lock (_serverSnapshotLock)
            _serverSnapshots[PresenceAddress.Sanitize(address) ?? address] = snapshot;
    }

    private void ConfigurePresence()
    {
        _presence.Configure(
            _data.GetCVar(CVars.DiscordPresenceEnabled),
            _data.GetCVar(CVars.DiscordPresenceShowNickname),
            _login.ActiveAccount?.Username);
    }

    private void ConnectorOnPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(Connector.Status))
        {
            if (_connector.Status == Connector.ConnectionStatus.ClientRunning && _pendingRecentConnection is { } pending)
            {
                _pendingRecentConnection = null;
                try
                {
                    _recentConnections.Record(
                        pending.AccountId,
                        pending.Address,
                        pending.Name,
                        DateTimeOffset.UtcNow,
                        pending.Snapshot?.PlayerCount,
                        pending.Snapshot?.PingMs);
                    SendEvent("recentConnections.updated", new { accountId = pending.AccountId });
                }
                catch (Exception error)
                {
                    Log.Warning(error, "Could not save the recent server connection");
                    SendEvent("app.error", new WorkerError("RECENT_CONNECTION_SAVE_FAILED", "The game is running, but recent connections could not be saved"));
                }
            }
            else if (_connector.Status is Connector.ConnectionStatus.ClientExited
                or Connector.ConnectionStatus.ConnectionFailed
                or Connector.ConnectionStatus.Cancelled
                or Connector.ConnectionStatus.UpdateError
                or Connector.ConnectionStatus.NotAContentBundle)
            {
                _pendingRecentConnection = null;
            }

            _playtimeTracker.ObserveStatus(_connector.Status);
            SendEvent("connection.progress", new
            {
                status = _connector.Status.ToString(),
                privacyPolicy = _connector.PrivacyPolicyInfo
            });

            _presence.ObserveStatus(_connector.Status);
        }
    }

    private void UpdaterOnPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(Updater.Progress) or nameof(Updater.Status) or nameof(Updater.Speed))
        {
            SendEvent("update.progress", new { status = _updater.Status.ToString(), progress = _updater.Progress, speed = _updater.Speed });
            if (_updater.Status is Updater.UpdateStatus.Ready or Updater.UpdateStatus.Error)
                SendEvent("update.completed", new { status = _updater.Status.ToString(), error = _updater.UpdateException?.Message });
            if (_updater.Status == Updater.UpdateStatus.Ready && _lastNotificationUpdateStatus != Updater.UpdateStatus.Ready)
            {
                var notification = _insights.AddNotification(_login.ActiveAccountId, "game-update", "Обновление завершено", "Игровые файлы Mados Launcher готовы к запуску.");
                SendEvent("notification.created", ToNotificationDto(notification));
            }
            _lastNotificationUpdateStatus = _updater.Status;
        }
    }

    private void SendResponse(string? id, object? result)
    {
        Write(new { v = 1, id, result });
    }

    private void SendError(string? id, WorkerError error)
    {
        Write(new { v = 1, id, error });
    }

    private void SendEvent(string eventName, object data)
    {
        Write(new { v = 1, @event = eventName, data });
    }

    private void Write(object value)
    {
        var json = JsonSerializer.Serialize(value, JsonOptions);
        lock (_writeLock)
        {
            _output.WriteLine(json);
            _output.Flush();
        }
    }

    private static string RequiredString(JsonElement parameters, string property)
    {
        var value = OptionalString(parameters, property);
        if (string.IsNullOrWhiteSpace(value))
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", $"Parameter '{property}' is required"));
        return value;
    }

    private static string? OptionalString(JsonElement parameters, string property)
    {
        return TryGetProperty(parameters, property, out var value) && value.ValueKind != JsonValueKind.Null
            ? value.GetString()
            : null;
    }

    private static string NoteTextParameter(JsonElement parameters)
    {
        if (!TryGetProperty(parameters, "text", out var value) || value.ValueKind is not JsonValueKind.String)
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", "Parameter 'text' is required"));
        return value.GetString() ?? string.Empty;
    }

    private static Guid RequiredGuid(JsonElement parameters, string property)
    {
        var text = RequiredString(parameters, property);
        if (!Guid.TryParse(text, out var value))
            throw new WorkerRpcException(new WorkerError("INVALID_PARAMS", $"Parameter '{property}' is not a valid identifier"));
        return value;
    }

    private static Guid? OptionalGuid(JsonElement parameters, string property)
    {
        var text = OptionalString(parameters, property);
        return text != null && Guid.TryParse(text, out var value) ? value : null;
    }

    private static bool TryGetProperty(JsonElement parameters, string property, out JsonElement value)
    {
        if (parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty(property, out value))
            return true;
        value = default;
        return false;
    }



    private sealed record PendingRecentConnection(
        Guid AccountId,
        string Address,
        string? Name,
        ServerStatusSnapshot? Snapshot);

    private sealed record WorkerError(string Code, string Message, object? Details = null);

    private sealed class WorkerRpcException(WorkerError error) : Exception(error.Message)
    {
        public WorkerError Error { get; } = error;
    }
}
