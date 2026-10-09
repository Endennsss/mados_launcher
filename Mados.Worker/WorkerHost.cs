using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
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
using SS14.Launcher.Models.OverrideAssets;
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
public sealed class WorkerHost
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
    private WorkerCommandBridge? _legacyBridge;
    private string? _pendingLegacyReason;

    private Task? _connectionTask;
    private CancellationTokenSource? _connectionCancellation;
    private PendingRecentConnection? _pendingRecentConnection;
    private Updater.UpdateStatus? _lastNotificationUpdateStatus;
    private readonly PresenceTracker _presence;

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
                    && method.GetString() is "tools.cdn.import" or "localServers.create" or "localServers.start" or "localServers.restart";
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
        lock (_cdnLock) _cdnCancellation?.Cancel();
        await Task.WhenAll(backgroundRequests);
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
        return method switch
        {
            "app.getState" => await GetStateAsync(),
            "app.getVersion" => new { version = LauncherVersion.Version?.ToString() ?? "unknown", name = "Mados Launcher" },
            "app.openDeepLink" => await OpenDeepLinkAsync(parameters),
            "app.shutdown" => Shutdown(),
            "auth.getAccounts" => GetAccounts(),
            "auth.login" => await LoginAsync(parameters),
            "auth.logout" => await LogoutAsync(parameters),
            "auth.switchAccount" => SwitchAccount(parameters),
            "servers.list" => await GetServersAsync(false),
            "servers.refresh" => await GetServersAsync(true),
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
            "updates.getStatus" => await GetUpdateStatusAsync(),
            "updates.start" => StartUpdate(parameters),
            _ => throw new WorkerRpcException(new WorkerError("METHOD_NOT_FOUND", $"Unknown worker method: {method}"))
        };
    }

    private async Task<object> GetStateAsync()
    {
        await _launcherInfo.LoadTask;
        var allowedVersions = _launcherInfo.Model?.AllowedVersions ?? Array.Empty<string>();
        var currentVersion = ConfigConstants.CurrentLauncherVersion;
        var processor = LauncherDiagnostics.GetProcessorModel();
        var intelWarning = processor.Contains("Intel", StringComparison.OrdinalIgnoreCase)
            && Regex.IsMatch(processor, @"i\d+-1[34]\d+(?:[A-Z]+)?(?:\s|$)", RegexOptions.IgnoreCase)
            && !processor.EndsWith("H", StringComparison.OrdinalIgnoreCase)
            && !processor.EndsWith("P", StringComparison.OrdinalIgnoreCase)
            && !processor.EndsWith("U", StringComparison.OrdinalIgnoreCase)
            && !_data.GetCVar(CVars.HasDismissedIntelDegradation);
        return new
        {
            ready = true,
            loggedIn = _login.ActiveAccount != null,
            activeAccount = GetAccountDto(_login.ActiveAccount),
            accounts = GetAccounts(),
            favorites = GetFavorites(),
            version = LauncherVersion.Version?.ToString() ?? "unknown",
            compatibility = new
            {
                outOfDate = _launcherInfo.Model != null && Array.IndexOf(allowedVersions, currentVersion) == -1,
                earlyAccess = !_data.GetCVar(CVars.HasDismissedEarlyAccessWarning),
                intelDegradation = intelWarning,
                rosetta = OperatingSystem.IsMacOS()
                    && processor.Contains("VirtualApple", StringComparison.OrdinalIgnoreCase)
                    && !_data.GetCVar(CVars.HasDismissedRosettaWarning),
                authOverride = ConfigConstants.IsAuthOverride
            },
            discord = GetDiscordSettings()
        };
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
        var accountId = RequiredGuid(parameters, "accountId");
        if (!_login.Logins.Lookup(accountId).HasValue)
            throw new WorkerRpcException(new WorkerError("ACCOUNT_NOT_FOUND", "Account was not found"));

        _login.ActiveAccountId = accountId;
        SendEvent("auth.changed", new { accounts = GetAccounts(), activeAccount = GetAccountDto(_login.ActiveAccount), favorites = GetFavorites() });
        ConfigurePresence();
        return GetAccountDto(_login.ActiveAccount)!;
    }

    private async Task<object> GetServersAsync(bool refreshMonitoring)
    {
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var servers = new Dictionary<string, ServerDto>(StringComparer.OrdinalIgnoreCase);
        var failedHubs = new List<string>();

        var hubs = ConfigConstants.DefaultHubUrls
            .Select(h => (Set: h, Display: h.Urls[0]))
            .Concat(_data.Hubs.OrderBy(h => h.Priority).Select(h => (Set: UrlFallbackSet.FromSingle(h.Address), Display: h.Address.AbsoluteUri)))
            .ToArray();

        foreach (var (hub, display) in hubs)
        {
            try
            {
                var entries = await _hub.GetServers(hub, cancel.Token);
                foreach (var entry in entries)
                {
                    if (servers.ContainsKey(entry.Address))
                        continue;

                    var status = entry.StatusData;
                    var parsedStatus = ServerStatusSnapshot.FromStatus(status, null);
                    servers[entry.Address] = new ServerDto(
                        entry.Address,
                        parsedStatus.Name,
                        parsedStatus.PlayerCount,
                        parsedStatus.SoftMaxPlayerCount,
                        parsedStatus.RoundStartTime,
                        parsedStatus.RunLevel,
                        parsedStatus.Tags,
                        "online",
                        display,
                        null,
                        parsedStatus.Language,
                        parsedStatus.Map,
                        parsedStatus.Mode);
                }
            }
            catch (Exception e)
            {
                failedHubs.Add(display);
                Log.Warning(e, "Failed to fetch hub server list from {Hub}", display);
            }
        }

        // Probe each server independently. Measuring the hub request once and
        // copying that duration to every entry makes all cards show the same
        // number even when the servers are in different regions.
        using (var pingGate = new SemaphoreSlim(12, 12))
        {
            var pingTasks = servers.Values
                .Select(server => MeasureServerPingAsync(server.Address, pingGate, cancel.Token))
                .ToArray();
            var pingResults = await Task.WhenAll(pingTasks);
            foreach (var pingResult in pingResults)
            {
                if (servers.TryGetValue(pingResult.Address, out var server))
                    servers[pingResult.Address] = server with { PingMs = pingResult.PingMs };
            }
        }

        lock (_serverSnapshotLock)
        {
            foreach (var server in servers.Values)
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

        var result = new
        {
            servers = servers.Values.ToArray(),
            failedHubs,
            partialError = failedHubs.Count > 0 && servers.Count > 0
        };
        SendEvent("servers.updated", result);
        if (refreshMonitoring && _login.ActiveAccountId is not null)
            await RefreshMonitoringAsync(servers.Values);
        return result;
    }

    private async Task<(string Address, long? PingMs)> MeasureServerPingAsync(string address, SemaphoreSlim gate, CancellationToken cancel)
    {
        var entered = false;
        try
        {
            await gate.WaitAsync(cancel);
            entered = true;
            return (address, await ServerPingProbe.MeasureAsync(_http, address, cancel));
        }
        catch (OperationCanceledException)
        {
            return (address, null);
        }
        finally
        {
            if (entered)
                gate.Release();
        }
    }

    private async Task<object> GetServerInfoAsync(JsonElement parameters)
    {
        var address = RequiredString(parameters, "address");
        var hubAddress = OptionalString(parameters, "hubAddress");
        if (string.IsNullOrWhiteSpace(hubAddress))
            hubAddress = ConfigConstants.DefaultHubUrls.FirstOrDefault()?.Urls.FirstOrDefault();
        if (string.IsNullOrWhiteSpace(hubAddress))
            throw new WorkerRpcException(new WorkerError("SERVER_INFO_UNAVAILABLE", "No server hub is configured"));

        if (!hubAddress.EndsWith("/", StringComparison.Ordinal))
            hubAddress += "/";

        try
        {
            using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var infoTask = _hub.GetServerInfo(address, hubAddress, cancel.Token);
            var statusTask = ServerStatusProbe.FetchAsync(_http, address, cancel.Token);
            var info = await infoTask;
            var status = await statusTask;
            return new
            {
                description = info.Desc,
                links = info.Links?.Select(link => new { name = link.Name, icon = link.Icon, url = link.Url }).ToArray()
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
        var favorite = _data.FavoriteServers.Lookup(address);
        if (!favorite.HasValue)
            throw new WorkerRpcException(new WorkerError("FAVORITE_NOT_FOUND", "Favorite server was not found"));

        _data.RemoveFavoriteServer(favorite.Value);
        _data.CommitConfig();
        return GetFavorites();
    }

    private async Task<object> GetNewsAsync()
    {
        var items = new List<NewsDto>();

        try
        {
            var feed = await FeedReader.ReadAsync(ConfigConstants.NewsFeedUrl);
            items.AddRange(feed.Items.Select(item => new NewsDto(
                item.Title ?? "Space Station 14",
                item.Link ?? ConfigConstants.NewsFeedUrl,
                item.PublishingDate,
                "Space Station 14",
                StripHtml(item.Description))));
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

        return items
            .Where(item => !string.IsNullOrWhiteSpace(item.Link))
            .GroupBy(item => item.Link, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.OrderByDescending(item => item.Date ?? DateTime.MinValue).First())
            .OrderByDescending(item => item.Date ?? DateTime.MinValue)
            .Take(20)
            .Select(item => new
            {
                title = item.Title,
                link = item.Link,
                date = item.Date,
                source = item.Source,
                summary = item.Summary
            }).ToArray();
    }

    private async Task<IReadOnlyList<NewsDto>> GetGitHubNewsAsync()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, ConfigConstants.MadosLauncherGitHubReleasesApi);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.UserAgent.ParseAdd("Mados.Launcher");
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();

        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (document.RootElement.ValueKind != JsonValueKind.Array)
            throw new JsonException("GitHub releases response is not an array");

        var result = new List<NewsDto>();
        foreach (var release in document.RootElement.EnumerateArray())
        {
            if (release.TryGetProperty("draft", out var draft) && draft.ValueKind == JsonValueKind.True)
                continue;

            var link = JsonString(release, "html_url");
            if (string.IsNullOrWhiteSpace(link))
                continue;

            var title = JsonString(release, "name") ?? JsonString(release, "tag_name") ?? "Mados Launcher release";
            var dateText = JsonString(release, "published_at") ?? JsonString(release, "created_at");
            DateTime? date = DateTime.TryParse(dateText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsedDate)
                ? parsedDate
                : null;
            var summary = StripHtml(JsonString(release, "body"));
            result.Add(new NewsDto(title, link, date, "GitHub · Mados Launcher", summary));
        }

        return result;
    }

    private static string? JsonString(JsonElement element, string property)
    {
        return element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static string? StripHtml(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;

        var plain = Regex.Replace(value, "<[^>]+>", " ");
        plain = Regex.Replace(plain, @"\s+", " ").Trim();
        return plain.Length > 220 ? $"{plain[..217]}…" : plain;
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
        SendEvent("settings.changed", new { discord = GetDiscordSettings(), favoriteAvailabilityNotifications = _data.GetCVar(CVars.FavoriteAvailabilityNotifications) });
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

    private async Task<object> RefreshMonitoringAsync(IEnumerable<ServerDto>? catalog = null)
    {
        var accountId = RequireActiveInsightsAccount();
        var favoriteTargets = _data.FavoriteServers.Items
            .Select(f => new FavoriteMonitorTarget(f.Address, f.Name))
            .ToArray();
        var catalogByAddress = catalog?
            .Select(server => (server, address: LauncherInsightsStore.NormalizeAddress(server.Address)))
            .GroupBy(item => item.address, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.First().server, StringComparer.OrdinalIgnoreCase);
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(15));

        foreach (var favorite in favoriteTargets)
        {
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
                _data.GetCVar(CVars.FavoriteAvailabilityNotifications));
            if (write.Notification is { } notification)
            {
                SendEvent("notification.created", ToNotificationDto(notification));
            }
        }

        var result = new
        {
            accountId,
            favorites = _insights.GetFavoriteSummaries(accountId, favoriteTargets).Select(ToFavoriteMonitorDto).ToArray()
        };
        SendEvent("monitoring.updated", result);
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
        => new { id = notification.Id, kind = notification.Kind, title = notification.Title, message = notification.Message, createdAt = notification.CreatedAtUtc, readAt = notification.ReadAtUtc };

    private object StartConnection(JsonElement parameters)
    {
        var address = RequiredString(parameters, "address");
        var reason = OptionalString(parameters, "reason");
        var requestedName = OptionalString(parameters, "name");
        var snapshot = GetServerSnapshot(address);
        var serverName = string.IsNullOrWhiteSpace(requestedName) ? snapshot?.Name : requestedName;
        if (_connectionTask is { IsCompleted: false })
            throw new WorkerRpcException(new WorkerError("CONNECTION_BUSY", "A connection is already in progress"));

        _presence.Prepare(address, serverName, _login.ActiveAccount?.Username, snapshot);
        _playtimeTracker.Prepare(_login.ActiveAccountId, PresenceAddress.Sanitize(address) ?? address, serverName, countable: true);
        _pendingRecentConnection = _login.ActiveAccountId is { } accountId && accountId != Guid.Empty
            ? new PendingRecentConnection(accountId, PresenceAddress.Sanitize(address) ?? address, serverName, snapshot)
            : null;
        _connectionCancellation?.Dispose();
        _connectionCancellation = new CancellationTokenSource();
        _connectionTask = ObserveConnectionAsync(address, reason, _connectionCancellation.Token);
        return new { started = true, address = PresenceAddress.Sanitize(address), reason, name = serverName };
    }

    private async Task ObserveConnectionAsync(string address, string? reason, CancellationToken cancel)
    {
        SendEvent("connection.started", new { address = PresenceAddress.Sanitize(address), reason });
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

    private async Task<object> GetUpdateStatusAsync()
    {
        await _launcherInfo.LoadTask;
        var model = _launcherInfo.Model;
        var current = ConfigConstants.CurrentLauncherVersion;
        var outOfDate = model != null && Array.IndexOf(model.AllowedVersions, current) == -1;
        return new { currentVersion = current, outOfDate, allowedVersions = model?.AllowedVersions ?? Array.Empty<string>() };
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

    private sealed record ServerDto(
        string Address,
        string? Name,
        int PlayerCount,
        int SoftMaxPlayerCount,
        string? RoundStartTime,
        string? RunLevel,
        string[] Tags,
        string Status,
        string HubAddress,
        long? PingMs,
        string? Language,
        string? Map,
        string? Mode);

    private sealed record NewsDto(string Title, string Link, DateTime? Date, string Source, string? Summary);

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
