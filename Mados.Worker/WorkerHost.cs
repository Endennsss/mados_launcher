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
    private readonly object _serverSnapshotLock = new();
    private readonly Dictionary<string, ServerStatusSnapshot> _serverSnapshots = new(StringComparer.OrdinalIgnoreCase);
    private WorkerCommandBridge? _legacyBridge;
    private string? _pendingLegacyReason;

    private Task? _connectionTask;
    private CancellationTokenSource? _connectionCancellation;
    private CancellationTokenSource? _presenceCancellation;
    private Task? _presenceTask;
    private PresenceConnection? _presenceConnection;

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
            _launcherInfo.Initialize();
            _content.Initialize();
            _overrideAssets.Initialize();
            await _login.Initialize();
            if (_data.SelectedLoginId is { } selected && _login.Logins.Lookup(selected).HasValue)
            {
                _login.ActiveAccountId = selected;
            }
            SendEvent("app.ready", await GetStateAsync());
            SendLauncherPresence();
            _legacyBridge = new WorkerCommandBridge(HandleLegacyCommandAsync);
            _legacyBridge.Start();
        }
        catch (Exception e)
        {
            Log.Error(e, "Worker initialization failed");
            SendEvent("app.error", new WorkerError("INITIALIZATION_FAILED", "Launcher initialization failed", e.Message));
            return;
        }

        while (!_shutdown.IsCancellationRequested)
        {
            var line = await Console.In.ReadLineAsync();
            if (line == null)
                break;

            if (string.IsNullOrWhiteSpace(line))
                continue;

            await HandleLineAsync(line);
        }

        _connectionCancellation?.Cancel();
        StopPresenceTracking();
        _playtimeTracker.Stop();
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

            if (!root.TryGetProperty("id", out var idElement)
                || !root.TryGetProperty("method", out var methodElement))
            {
                SendError(null, new WorkerError("INVALID_REQUEST", "Request must include id and method"));
                return;
            }

            var id = idElement.ValueKind == JsonValueKind.String
                ? idElement.GetString()
                : idElement.GetRawText();
            var method = methodElement.GetString();
            if (string.IsNullOrWhiteSpace(method))
            {
                SendError(id, new WorkerError("INVALID_REQUEST", "Request method is empty"));
                return;
            }

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
            "servers.list" or "servers.refresh" => await GetServersAsync(),
            "servers.info" => await GetServerInfoAsync(parameters),
            "favorites.list" => GetFavorites(),
            "favorites.add" => AddFavorite(parameters),
            "favorites.remove" => RemoveFavorite(parameters),
            "playtime.getSummary" => GetPlaytimeSummary(parameters),
            "playtime.clear" => ClearPlaytime(),
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
        SendEvent("auth.changed", new { accounts = GetAccounts(), activeAccount = GetAccountDto(_login.ActiveAccount) });
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
        SendEvent("auth.changed", new { accounts = GetAccounts(), activeAccount = GetAccountDto(_login.ActiveAccount) });
        return new { ok = true };
    }

    private object SwitchAccount(JsonElement parameters)
    {
        var accountId = RequiredGuid(parameters, "accountId");
        if (!_login.Logins.Lookup(accountId).HasValue)
            throw new WorkerRpcException(new WorkerError("ACCOUNT_NOT_FOUND", "Account was not found"));

        _login.ActiveAccountId = accountId;
        SendEvent("auth.changed", new { accounts = GetAccounts(), activeAccount = GetAccountDto(_login.ActiveAccount) });
        return GetAccountDto(_login.ActiveAccount)!;
    }

    private async Task<object> GetServersAsync()
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
                _serverSnapshots[server.Address] = new ServerStatusSnapshot(
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
            discordPresenceShowNickname = _data.GetCVar(CVars.DiscordPresenceShowNickname)
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
        if (TryGetProperty(parameters, "language", out var language))
            _data.SetCVar(CVars.Language, language.ValueKind == JsonValueKind.Null ? null : language.GetString());
        if (TryGetProperty(parameters, "dismissEarlyAccess", out var dismissEarlyAccess) && dismissEarlyAccess.GetBoolean())
            _data.SetCVar(CVars.HasDismissedEarlyAccessWarning, true);
        if (TryGetProperty(parameters, "dismissIntelDegradation", out var dismissIntel) && dismissIntel.GetBoolean())
            _data.SetCVar(CVars.HasDismissedIntelDegradation, true);
        if (TryGetProperty(parameters, "dismissRosetta", out var dismissRosetta) && dismissRosetta.GetBoolean())
            _data.SetCVar(CVars.HasDismissedRosettaWarning, true);

        _data.CommitConfig();
        SendEvent("settings.changed", new { discord = GetDiscordSettings() });
        if (!_data.GetCVar(CVars.DiscordPresenceEnabled))
            SendLauncherPresence();
        else
            PublishCurrentPresence();
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

    private object StartConnection(JsonElement parameters)
    {
        var address = RequiredString(parameters, "address");
        var reason = OptionalString(parameters, "reason");
        var requestedName = OptionalString(parameters, "name");
        var snapshot = GetServerSnapshot(address);
        var serverName = string.IsNullOrWhiteSpace(requestedName) ? snapshot?.Name : requestedName;
        if (_connectionTask is { IsCompleted: false })
            throw new WorkerRpcException(new WorkerError("CONNECTION_BUSY", "A connection is already in progress"));

        StopPresenceTracking();
        _presenceConnection = new PresenceConnection(
            address,
            serverName,
            _login.ActiveAccount?.Username,
            snapshot);
        SendPresenceSnapshot("connecting", snapshot, null);
        _playtimeTracker.Prepare(_login.ActiveAccountId, address, serverName, countable: true);
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
            StopPresenceTracking();
            SendLauncherPresence();
            SendEvent("connection.failed", new { target = PresenceAddress.Sanitize(address), status = "ConnectionFailed", message = "The connection could not be completed" });
        }
    }

    private object CancelConnection()
    {
        _connectionCancellation?.Cancel();
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

        StopPresenceTracking();
        _presenceConnection = null;
        SendLauncherPresence();
        _playtimeTracker.Prepare(null, path, null, countable: false);
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
            SendLauncherPresence();
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
        StopPresenceTracking();
        _playtimeTracker.Stop();
        _shutdown.Cancel();
        return new { shuttingDown = true };
    }

    private ServerStatusSnapshot? GetServerSnapshot(string address)
    {
        lock (_serverSnapshotLock)
            return _serverSnapshots.TryGetValue(address, out var snapshot) ? snapshot : null;
    }

    private void UpdateServerSnapshot(string address, ServerStatusSnapshot snapshot)
    {
        lock (_serverSnapshotLock)
            _serverSnapshots[address] = snapshot;
    }

    private void StartPresenceTracking()
    {
        if (_presenceConnection is not { } connection)
            return;

        StopPresenceTracking();
        connection.StartedAtUtc = DateTimeOffset.UtcNow;
        _presenceCancellation = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
        _presenceTask = PresenceLoopAsync(connection, _presenceCancellation.Token);
    }

    private void StopPresenceTracking()
    {
        _presenceCancellation?.Cancel();
        _presenceCancellation?.Dispose();
        _presenceCancellation = null;
        _presenceTask = null;
    }

    private async Task PresenceLoopAsync(PresenceConnection connection, CancellationToken cancel)
    {
        try
        {
            SendPresenceSnapshot("playing", connection.InitialSnapshot, connection);
            while (!cancel.IsCancellationRequested)
            {
                var snapshot = await ServerStatusProbe.FetchAsync(_http, connection.Address, cancel);
                if (snapshot != null)
                {
                    connection.InitialSnapshot = snapshot;
                    UpdateServerSnapshot(connection.Address, snapshot);
                }

                SendPresenceSnapshot("playing", snapshot ?? connection.InitialSnapshot, connection);
                await Task.Delay(TimeSpan.FromSeconds(30), cancel);
            }
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            // Normal when the client exits or the worker shuts down.
        }
        catch (Exception error)
        {
            Log.Warning(error, "Discord presence status polling stopped");
        }
    }

    private void PublishCurrentPresence()
    {
        if (_presenceConnection is { } connection && _connector.Status == Connector.ConnectionStatus.ClientRunning)
        {
            SendPresenceSnapshot("playing", connection.InitialSnapshot, connection);
            return;
        }

        if (_presenceConnection != null && _connector.Status is Connector.ConnectionStatus.Updating)
        {
            SendPresenceSnapshot("updating", _presenceConnection.InitialSnapshot, _presenceConnection);
            return;
        }

        SendLauncherPresence();
    }

    private void SendLauncherPresence()
    {
        SendPresenceSnapshot("launcher", null, null);
    }

    private void SendPresenceSnapshot(string state, ServerStatusSnapshot? snapshot, PresenceConnection? connection)
    {
        if (connection != null && !ReferenceEquals(_presenceConnection, connection))
            return;

        var showNickname = _data.GetCVar(CVars.DiscordPresenceShowNickname);
        var enabled = _data.GetCVar(CVars.DiscordPresenceEnabled);
        var active = connection ?? _presenceConnection;
        var serverName = active?.ServerName ?? snapshot?.Name;
        var address = active?.Address;
        var startedAt = active?.StartedAtUtc;
        SendEvent("presence.updated", new
        {
            state,
            enabled,
            showNickname,
            accountName = showNickname ? active?.AccountName ?? _login.ActiveAccount?.Username : null,
            serverName,
            // A deep link can contain a connection token. Presence is sent to
            // Electron and may then be sent to Discord, so remove credentials
            // and query/fragment data at the worker boundary.
            address = state == "launcher" ? null : PresenceAddress.Sanitize(address),
            playerCount = snapshot?.PlayerCount,
            softMaxPlayerCount = snapshot?.SoftMaxPlayerCount,
            pingMs = snapshot?.PingMs,
            map = snapshot?.Map,
            mode = snapshot?.Mode,
            startedAt = state == "playing" ? startedAt : null
        });
    }


    private void ConnectorOnPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(Connector.Status))
        {
            _playtimeTracker.ObserveStatus(_connector.Status);
            SendEvent("connection.progress", new
            {
                status = _connector.Status.ToString(),
                privacyPolicy = _connector.PrivacyPolicyInfo
            });

            switch (_connector.Status)
            {
                case Connector.ConnectionStatus.Updating:
                    SendPresenceSnapshot("updating", _presenceConnection?.InitialSnapshot, _presenceConnection);
                    break;
                case Connector.ConnectionStatus.Connecting:
                case Connector.ConnectionStatus.AwaitingPrivacyPolicyAcceptance:
                case Connector.ConnectionStatus.StartingClient:
                    SendPresenceSnapshot("connecting", _presenceConnection?.InitialSnapshot, _presenceConnection);
                    break;
                case Connector.ConnectionStatus.ClientRunning:
                    StartPresenceTracking();
                    break;
                case Connector.ConnectionStatus.ClientExited:
                case Connector.ConnectionStatus.ConnectionFailed:
                case Connector.ConnectionStatus.UpdateError:
                case Connector.ConnectionStatus.Cancelled:
                case Connector.ConnectionStatus.NotAContentBundle:
                    StopPresenceTracking();
                    _presenceConnection = null;
                    SendLauncherPresence();
                    break;
            }
        }
    }

    private void UpdaterOnPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(Updater.Progress) or nameof(Updater.Status) or nameof(Updater.Speed))
        {
            SendEvent("update.progress", new { status = _updater.Status.ToString(), progress = _updater.Progress, speed = _updater.Speed });
            if (_updater.Status is Updater.UpdateStatus.Ready or Updater.UpdateStatus.Error)
                SendEvent("update.completed", new { status = _updater.Status.ToString(), error = _updater.UpdateException?.Message });
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

    private sealed class PresenceConnection(string address, string? serverName, string? accountName, ServerStatusSnapshot? initialSnapshot)
    {
        public string Address { get; } = address;
        public string? ServerName { get; } = serverName;
        public string? AccountName { get; } = accountName;
        public ServerStatusSnapshot? InitialSnapshot { get; set; } = initialSnapshot;
        public DateTimeOffset? StartedAtUtc { get; set; }
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

    private sealed record WorkerError(string Code, string Message, object? Details = null);

    private sealed class WorkerRpcException(WorkerError error) : Exception(error.Message)
    {
        public WorkerError Error { get; } = error;
    }
}
