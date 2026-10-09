#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace SS14.Launcher.Worker;

/// <summary>
/// Imports packaged Robust server builds and owns the one local server process
/// allowed by the launcher. Renderer input is reduced to typed values here;
/// executable paths and command lines never come from the renderer unchecked.
/// </summary>
public sealed class LocalServerManager : IAsyncDisposable
{
    public const int DefaultPort = 1212;
    public const string DefaultBindAddress = "127.0.0.1";
    private const long MaxArchiveBytes = 4L * 1024 * 1024 * 1024;
    private const long MaxEntryBytes = 8L * 1024 * 1024 * 1024;
    private readonly HttpClient _cdnHttp;
    private readonly bool _ownsCdnHttp;
    private readonly LocalServerStore _store;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly object _processLock = new();
    private readonly object _logLock = new();
    private readonly string _managedRoot;
    private Task[] _outputTasks = Array.Empty<Task>();
    private Process? _process;
    private StreamWriter? _processInput;
    private StreamWriter? _logWriter;
    private string? _activeProfileId;
    private DateTimeOffset? _startedAt;
    private string? _lastError;
    private LocalServerStatus _status = LocalServerStatus.Idle;

    public LocalServerManager(HttpClient http, LocalServerStore? store = null, string? managedRoot = null, HttpClient? cdnHttp = null)
    {
        _cdnHttp = cdnHttp ?? http;
        _ownsCdnHttp = cdnHttp is not null;
        _store = store ?? new LocalServerStore();
        _managedRoot = Path.GetFullPath(managedRoot ?? Path.Combine(LauncherPaths.DirUserData, "local-servers"));
        Directory.CreateDirectory(_managedRoot);
    }

    public event Action<LocalServerEvent>? Changed;

    public IReadOnlyList<LocalServerProfile> ListProfiles() => _store.ListProfiles();

    public LocalServerProfile UpdateProfileSettings(string id, string? name, int? port, string? bindAddress)
    {
        var profile = _store.Find(id) ?? throw new LocalServerException("PROFILE_NOT_FOUND", "Локальный профиль не найден.");
        EnsureManaged(profile.InstallPath);
        if (port is < 1 or > 65535)
            throw new LocalServerException("INVALID_PARAMS", "Порт должен быть от 1 до 65535.");
        var bind = string.IsNullOrWhiteSpace(bindAddress) ? profile.BindAddress : bindAddress.Trim();
        if (!IPAddress.TryParse(bind, out var ip) || !IPAddress.IsLoopback(ip) || !string.Equals(bind, "127.0.0.1", StringComparison.Ordinal))
            throw new LocalServerException("INVALID_PARAMS", "Локальный сервер может слушать только loopback-адрес.");
        var updated = profile with
        {
            Name = NormalizeName(name) ?? profile.Name,
            Port = port ?? profile.Port,
            BindAddress = bind,
            UpdatedAtUtc = DateTimeOffset.UtcNow
        };
        if (File.Exists(profile.ConfigPath))
        {
            var config = File.ReadAllText(profile.ConfigPath);
            var changed = SetTomlNetValue(config, "port", updated.Port.ToString(System.Globalization.CultureInfo.InvariantCulture));
            changed = SetTomlNetValue(changed, "bind", $"\"{updated.BindAddress}\"");
            if (!ValidateToml(changed, out var error))
                throw new LocalServerException("INVALID_TOML", error ?? "Конфигурация некорректна.");
            _store.AddBackup(CreatePersistentBackup(profile, "profile-edit"));
            var temp = profile.ConfigPath + ".tmp-" + Guid.NewGuid().ToString("N");
            File.WriteAllText(temp, changed, Encoding.UTF8);
            File.Move(temp, profile.ConfigPath, true);
        }
        return _store.Update(updated);
    }

    public async Task<bool> RemoveProfileAsync(string id, CancellationToken cancellationToken = default)
    {
        await StopIfActiveAsync(id, cancellationToken);
        var profile = _store.Find(id);
        if (profile is null) return false;
        EnsureManaged(profile.InstallPath);
        var backups = _store.ListBackups(id);
        var removed = _store.Remove(id);
        if (removed)
        {
            TryDeleteDirectory(profile.InstallPath);
            foreach (var backup in backups)
            {
                var backupRoot = Path.GetDirectoryName(backup.ConfigPath);
                if (backupRoot is not null)
                {
                    try { EnsureManaged(backupRoot); TryDeleteDirectory(backupRoot); } catch (LocalServerException) { }
                }
            }
        }
        return removed;
    }

    public string GetLogPath(string id)
    {
        if (_store.Find(id) is null) throw new LocalServerException("PROFILE_NOT_FOUND", "Локальный профиль не найден.");
        return Path.Combine(LauncherPaths.DirLogs, $"local-server-{id}.log");
    }

    public async Task<CdnInspectResult> InspectAsync(string source, CancellationToken cancellationToken = default)
    {
        var input = ValidateSource(source);
        if (File.Exists(input))
        {
            if (!string.Equals(Path.GetExtension(input), ".zip", StringComparison.OrdinalIgnoreCase))
                throw new LocalServerException("INVALID_SOURCE", "Выберите ZIP-файл сборки сервера.");
            var info = new FileInfo(input);
            return new CdnInspectResult(input, "zip", new[] { BuildVariant(input, info.Length, null) with { PublishedAt = info.LastWriteTimeUtc } });
        }

        if (Uri.TryCreate(input, UriKind.Absolute, out var sourceUri) && sourceUri.AbsolutePath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            using var headers = await SendCdnGetAsync(input, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            headers.EnsureSuccessStatusCode();
            return new CdnInspectResult(input, "zip", new[] { BuildVariant(input, headers.Content.Headers.ContentLength, null) with { PublishedAt = headers.Content.Headers.LastModified } });
        }

        using var response = await SendCdnGetAsync(input, HttpCompletionOption.ResponseContentRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        var html = await response.Content.ReadAsStringAsync(cancellationToken);
        var variants = ParseCdnPage(input, html);
        if (variants.Count == 0)
            throw new LocalServerException("NO_BUILDS", "На CDN-странице не найдены ZIP-сборки сервера.");
        return new CdnInspectResult(input, "page", variants);
    }

    public async Task<LocalServerProfile> ImportAsync(string source, string? selectedUrl, string? profileId,
        string? name, int? port, CancellationToken cancellationToken = default)
    {
        var inspection = await InspectAsync(source, cancellationToken);
        var selected = SelectVariant(inspection.Variants, selectedUrl);
        var current = profileId is null ? null : _store.Find(profileId);
        if (profileId is not null && current is null)
            throw new LocalServerException("PROFILE_NOT_FOUND", "Локальный профиль не найден.");

        var targetId = current?.Id ?? Guid.NewGuid().ToString("N");
        var root = current?.InstallPath ?? Path.Combine(_managedRoot, targetId);
        EnsureManaged(root);
        Directory.CreateDirectory(Path.GetDirectoryName(root)!);
        var staging = root + ".staging-" + Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(staging);
        var archivePath = Path.Combine(staging, "server-build.zip");
        string? movedBackupRoot = null;
        try
        {
            await DownloadToFileAsync(selected.Url, archivePath, cancellationToken);
            Emit(LocalServerEvent.ProgressEvent("extracting", null, null, null));
            ValidateArchive(archivePath);
            ExtractArchive(archivePath, staging, cancellationToken);
            File.Delete(archivePath);
            var executable = FindServerExecutable(staging);
            if (executable is null)
                throw new LocalServerException("SERVER_EXECUTABLE_NOT_FOUND", "В сборке не найден Robust.Server или run_server.bat.");

            var actualRoot = ResolveBuildRoot(staging, executable);
            if (current is not null) await StopIfActiveAsync(current.Id, cancellationToken);
            (string TempRoot, string DataPath, string ConfigPath)? preservedData = current is null ? null : await PreserveExistingAsync(current, cancellationToken);
            if (current is not null)
            {
                var backupRoot = root + ".backup-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss", System.Globalization.CultureInfo.InvariantCulture);
                if (Directory.Exists(root))
                {
                    Directory.Move(root, backupRoot);
                    movedBackupRoot = backupRoot;
                    _store.AddBackup(CreatePersistentBackup(current, "manual-update", backupRoot));
                }
                Directory.Move(actualRoot, root);
            }
            else
            {
                Directory.Move(actualRoot, root);
            }

            var config = Path.Combine(root, "server_config.toml");
            var dataPath = Path.Combine(root, "data");
            Directory.CreateDirectory(dataPath);
            if (!File.Exists(config))
                await File.WriteAllTextAsync(config, DefaultConfig(port ?? DefaultPort, DefaultBindAddress), cancellationToken);
            if (preservedData is { } preserved)
            {
                if (Directory.Exists(preserved.DataPath))
                    CopyDirectory(preserved.DataPath, dataPath, overwrite: true);
                if (File.Exists(preserved.ConfigPath))
                    File.Copy(preserved.ConfigPath, config, true);
                TryDeleteDirectory(preserved.TempRoot);
            }
            var configuredPort = port ?? current?.Port ?? DefaultPort;
            var protectedConfig = LocalServerConfig.ProtectLocal(await File.ReadAllTextAsync(config, cancellationToken), configuredPort);
            await File.WriteAllTextAsync(config, protectedConfig, cancellationToken);

            var now = DateTimeOffset.UtcNow;
            var variant = selected;
            var profile = new LocalServerProfile(
                targetId,
                NormalizeName(name) ?? current?.Name ?? InferName(source),
                SafeSource(source),
                root,
                variant.Version ?? "unknown",
                variant.Platform ?? CurrentPlatform(),
                variant.Architecture ?? CurrentArchitecture(),
                configuredPort,
                current?.BindAddress ?? DefaultBindAddress,
                dataPath,
                config,
                current?.CreatedAtUtc ?? now,
                now,
                current?.LastStartedAtUtc);
            if (current is null)
                _store.Create(profile);
            else
                _store.Update(profile);
            if (movedBackupRoot is not null) { TryDeleteDirectory(movedBackupRoot); movedBackupRoot = null; }
            Emit(LocalServerEvent.ProgressEvent("ready", profile.Id, 1, null));
            return profile;
        }
        catch
        {
            if (movedBackupRoot is not null && Directory.Exists(movedBackupRoot))
            {
                try { TryDeleteDirectory(root); Directory.Move(movedBackupRoot, root); } catch { }
            }
            TryDeleteDirectory(staging);
            throw;
        }
        finally
        {
            TryDeleteFile(archivePath);
            TryDeleteDirectory(staging);
        }
    }

    public async Task<LocalServerRuntimeStatus> StartAsync(string id, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_process is { HasExited: false })
            {
                if (string.Equals(_activeProfileId, id, StringComparison.Ordinal))
                    return GetStatus();
                throw new LocalServerException("LOCAL_SERVER_BUSY", "Сначала остановите уже работающий локальный сервер.");
            }

            var profile = _store.Find(id) ?? throw new LocalServerException("PROFILE_NOT_FOUND", "Локальный профиль не найден.");
            EnsureManaged(profile.InstallPath);
            if (!Directory.Exists(profile.InstallPath))
                throw new LocalServerException("INSTALL_MISSING", "Папка установленной сборки не найдена.");
            LocalServerConfig.ValidateBind(profile.BindAddress);
            LocalServerConfig.ValidatePort(profile.Port);
            var localConfig = LocalServerConfig.ProtectLocal(await File.ReadAllTextAsync(profile.ConfigPath, cancellationToken), profile.Port, profile.BindAddress);
            await File.WriteAllTextAsync(profile.ConfigPath, localConfig, cancellationToken);
            if (!IsPortAvailable(profile.BindAddress, profile.Port))
                throw new LocalServerException("PORT_IN_USE", $"Порт {profile.Port} уже занят.");
            var executable = FindServerExecutable(profile.InstallPath);
            if (executable is null)
                throw new LocalServerException("SERVER_EXECUTABLE_NOT_FOUND", "В установленной сборке не найден серверный executable.");

            _activeProfileId = profile.Id;
            _lastError = null;
            SetStatus(LocalServerStatus.Starting, profile.Id);
            var logPath = Path.Combine(LauncherPaths.DirLogs, $"local-server-{profile.Id}.log");
            Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
            _logWriter = new StreamWriter(new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.Read)) { AutoFlush = true };
            var startInfo = BuildStartInfo(executable, profile.InstallPath);
            var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            process.Exited += (_, _) => _ = HandleExitedAsync(process, profile.Id);
            if (!process.Start())
                throw new LocalServerException("PROCESS_START_FAILED", "Не удалось запустить локальный сервер.");
            _process = process;
            _processInput = startInfo.RedirectStandardInput ? process.StandardInput : null;
            _startedAt = DateTimeOffset.UtcNow;
            _store.MarkStarted(profile.Id, _startedAt.Value);
            _outputTasks = new[] { ReadOutputAsync(process.StandardOutput, "stdout", profile.Id, _logWriter), ReadOutputAsync(process.StandardError, "stderr", profile.Id, _logWriter) };
            Emit(LocalServerEvent.StatusEvent(profile.Id, LocalServerStatus.Starting, process.Id, profile.Port, _startedAt, null));

            var ready = await WaitForPortAsync(profile.BindAddress, profile.Port, process, cancellationToken);
            if (!ready)
                throw new LocalServerException("START_TIMEOUT", "Сервер не открыл порт вовремя.");
            SetStatus(LocalServerStatus.Running, profile.Id);
            return GetStatus();
        }
        catch (Exception error)
        {
            _lastError = error is LocalServerException local ? local.Message : "Не удалось запустить локальный сервер.";
            SetStatus(LocalServerStatus.Error, _activeProfileId);
            await StopProcessOnlyAsync();
            throw;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<LocalServerRuntimeStatus> StopAsync(string? id = null, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_process is null || _process.HasExited)
            {
                if (_activeProfileId is not null)
                    SetStatus(LocalServerStatus.Stopped, _activeProfileId);
                if (_process is not null)
                    await StopProcessOnlyAsync();
                return GetStatus();
            }
            if (id is not null && !string.Equals(id, _activeProfileId, StringComparison.Ordinal))
                throw new LocalServerException("PROFILE_NOT_RUNNING", "Этот профиль сейчас не запущен.");
            var activeId = _activeProfileId;
            SetStatus(LocalServerStatus.Stopping, activeId);
            try
            {
                if (_processInput is not null)
                {
                    await _processInput.WriteLineAsync("quit");
                    await _processInput.FlushAsync(cancellationToken);
                }
            }
            catch (Exception) { /* process may have already closed stdin */ }
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            try { await _process.WaitForExitAsync(timeout.Token); } catch (OperationCanceledException) { }
            if (!_process.HasExited)
            {
                try { _process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                try { await _process.WaitForExitAsync(cancellationToken); } catch (OperationCanceledException) { }
            }
            await StopProcessOnlyAsync();
            SetStatus(LocalServerStatus.Stopped, activeId);
            return GetStatus();
        }
        finally
        {
            _gate.Release();
        }
    }

    public Task<LocalServerRuntimeStatus> RestartAsync(string id, CancellationToken cancellationToken = default)
        => RestartCoreAsync(id, cancellationToken);

    private async Task<LocalServerRuntimeStatus> RestartCoreAsync(string id, CancellationToken cancellationToken)
    {
        await StopAsync(id, cancellationToken);
        return await StartAsync(id, cancellationToken);
    }

    public LocalServerRuntimeStatus GetStatus()
    {
        lock (_processLock)
        {
            int? pid = _process is { HasExited: false } process ? process.Id : null;
            return new LocalServerRuntimeStatus(_status, _activeProfileId, pid, _startedAt, _lastError, _store.Find(_activeProfileId ?? "")?.Port);
        }
    }

    public async Task<string> GetConfigAsync(string id, CancellationToken cancellationToken = default)
    {
        var profile = _store.Find(id) ?? throw new LocalServerException("PROFILE_NOT_FOUND", "Локальный профиль не найден.");
        var text = File.Exists(profile.ConfigPath) ? await File.ReadAllTextAsync(profile.ConfigPath, cancellationToken) : DefaultConfig(profile.Port, profile.BindAddress);
        return LocalServerConfig.Read(text, profile.Name, profile.Port).RawToml;
    }

    public async Task<LocalServerConfiguration> GetConfigurationAsync(string id, CancellationToken cancellationToken = default)
    {
        var profile = _store.Find(id) ?? throw new LocalServerException("PROFILE_NOT_FOUND", "Локальный профиль не найден.");
        var content = File.Exists(profile.ConfigPath) ? await File.ReadAllTextAsync(profile.ConfigPath, cancellationToken) : DefaultConfig(profile.Port, profile.BindAddress);
        try { return LocalServerConfig.Read(content, profile.Name, profile.Port); }
        catch (LocalServerException) { throw; }
        catch (Exception) { throw new LocalServerException("INVALID_TOML", "Конфигурация не является корректным TOML."); }
    }

    public async Task<LocalServerConfiguration> SaveConfigurationAsync(string id, LocalServerConfiguration configuration, CancellationToken cancellationToken = default)
    {
        var profile = _store.Find(id) ?? throw new LocalServerException("PROFILE_NOT_FOUND", "Локальный профиль не найден.");
        var original = File.Exists(profile.ConfigPath) ? await File.ReadAllTextAsync(profile.ConfigPath, cancellationToken) : DefaultConfig(profile.Port, profile.BindAddress);
        var merged = LocalServerConfig.Merge(original, configuration);
        await SaveConfigAsync(id, merged, cancellationToken);
        // Keep the profile metadata in sync with the authoritative TOML. This
        // prevents a later manual build update from silently restoring the old
        // port/bind values, and makes the profile card reflect the form.
        var updated = _store.Find(id);
        if (updated is not null)
        {
            var displayName = string.IsNullOrWhiteSpace(configuration.Name) ? updated.Name : NormalizeName(configuration.Name) ?? updated.Name;
            _store.Update(updated with
            {
                Name = displayName,
                Port = configuration.Port,
                BindAddress = configuration.BindAddress,
                UpdatedAtUtc = DateTimeOffset.UtcNow
            });
        }
        return await GetConfigurationAsync(id, cancellationToken);
    }

    public async Task SaveConfigAsync(string id, string content, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(content))
            throw new LocalServerException("INVALID_TOML", "Конфигурация не может быть пустой.");
        var profile = _store.Find(id) ?? throw new LocalServerException("PROFILE_NOT_FOUND", "Локальный профиль не найден.");
        var original = File.Exists(profile.ConfigPath) ? await File.ReadAllTextAsync(profile.ConfigPath, cancellationToken) : DefaultConfig(profile.Port, profile.BindAddress);
        content = LocalServerConfig.MergeRaw(original, content, profile.Port);
        if (File.Exists(profile.ConfigPath))
        {
            _store.AddBackup(CreatePersistentBackup(profile, "config-edit"));
        }
        var temp = profile.ConfigPath + ".tmp-" + Guid.NewGuid().ToString("N");
        await File.WriteAllTextAsync(temp, content.Replace("\r\n", "\n", StringComparison.Ordinal), Encoding.UTF8, cancellationToken);
        File.Move(temp, profile.ConfigPath, true);
        var parsed = LocalServerConfig.Read(content, profile.Name, profile.Port);
        _store.Update(profile with
        {
            Port = parsed.Port,
            BindAddress = parsed.BindAddress,
            UpdatedAtUtc = DateTimeOffset.UtcNow
        });
        Emit(LocalServerEvent.ConfigChanged(profile.Id));
    }

    public IReadOnlyList<LocalServerBackup> ListBackups(string profileId)
    {
        if (_store.Find(profileId) is null) throw new LocalServerException("PROFILE_NOT_FOUND", "Локальный профиль не найден.");
        return _store.ListBackups(profileId);
    }

    public async Task RollbackAsync(string profileId, string backupId, CancellationToken cancellationToken = default)
    {
        var profile = _store.Find(profileId) ?? throw new LocalServerException("PROFILE_NOT_FOUND", "Локальный профиль не найден.");
        var backup = _store.FindBackup(profileId, backupId) ?? throw new LocalServerException("BACKUP_NOT_FOUND", "Резервная копия не найдена.");
        EnsureManaged(profile.InstallPath);
        EnsureManaged(backup.ConfigPath);
        EnsureManaged(backup.DataPath);
        await StopIfActiveAsync(profileId, cancellationToken);
        var backupRoot = Path.GetDirectoryName(backup.ConfigPath)!;
        var metadata = Path.Combine(backupRoot, "mados-profile.json");
        if (File.Exists(metadata))
        {
            var oldProfile = JsonSerializer.Deserialize<LocalServerProfile>(await File.ReadAllTextAsync(metadata, cancellationToken))
                ?? throw new LocalServerException("INVALID_BACKUP", "Метаданные резервной копии повреждены.");
            var safety = CreatePersistentBackup(profile, "before-rollback");
            _store.AddBackup(safety);
            try
            {
                Directory.Delete(profile.InstallPath, true);
                CopyDirectory(backupRoot, profile.InstallPath, true);
                _store.Update(oldProfile with { InstallPath = profile.InstallPath, DataPath = profile.DataPath, ConfigPath = profile.ConfigPath, UpdatedAtUtc = DateTimeOffset.UtcNow });
            }
            catch
            {
                if (Directory.Exists(profile.InstallPath)) Directory.Delete(profile.InstallPath, true);
                CopyDirectory(Path.GetDirectoryName(safety.ConfigPath)!, profile.InstallPath, true);
                throw;
            }
            Emit(LocalServerEvent.ConfigChanged(profile.Id));
            return;
        }
        _store.AddBackup(CreatePersistentBackup(profile, "before-config-rollback"));
        if (File.Exists(backup.ConfigPath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(profile.ConfigPath)!);
            File.Copy(backup.ConfigPath, profile.ConfigPath, true);
        }
        if (Directory.Exists(backup.DataPath))
        {
            EnsureManaged(profile.DataPath);
            if (Directory.Exists(profile.DataPath)) Directory.Delete(profile.DataPath, true);
            CopyDirectory(backup.DataPath, profile.DataPath, true);
        }
        Emit(LocalServerEvent.ConfigChanged(profile.Id));
    }

    public static bool ValidateToml(string text, out string? error)
    {
        try { LocalServerConfig.Parse(text); error = null; return true; }
        catch (LocalServerException exception) { error = exception.Message; return false; }
        catch (Exception exception) { error = exception.Message; return false; }
    }

    private static string SetTomlNetValue(string content, string key, string value)
    {
        var lines = content.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').ToList();
        var inNet = false;
        var changed = false;
        for (var i = 0; i < lines.Count; i++)
        {
            var trimmed = lines[i].Trim();
            if (trimmed.StartsWith('['))
                inNet = string.Equals(trimmed, "[net]", StringComparison.OrdinalIgnoreCase);
            if (!inNet || trimmed.StartsWith('#')) continue;
            var equals = trimmed.IndexOf('=');
            if (equals <= 0 || !string.Equals(trimmed[..equals].Trim(), key, StringComparison.OrdinalIgnoreCase)) continue;
            var indent = lines[i][..(lines[i].Length - lines[i].TrimStart().Length)];
            lines[i] = $"{indent}{key} = {value}";
            changed = true;
            break;
        }
        if (!changed)
        {
            var index = lines.FindIndex(line => string.Equals(line.Trim(), "[net]", StringComparison.OrdinalIgnoreCase));
            if (index < 0) { lines.Insert(0, "[net]"); index = 0; }
            lines.Insert(index + 1, $"{key} = {value}");
        }
        return string.Join('\n', lines);
    }

    public static bool IsPortAvailable(string bindAddress, int port)
    {
        try
        {
            var address = IPAddress.TryParse(bindAddress, out var parsed) ? parsed : IPAddress.Loopback;
            using var listener = new TcpListener(address, port);
            listener.Start();
            listener.Stop();
            return true;
        }
        catch (SocketException) { return false; }
    }

    public async ValueTask DisposeAsync()
    {
        try { await StopAsync(); } catch { await StopProcessOnlyAsync(); }
        if (_ownsCdnHttp) _cdnHttp.Dispose();
        _gate.Dispose();
    }

    private async Task<HttpResponseMessage> SendCdnGetAsync(string source, HttpCompletionOption completion, CancellationToken cancellationToken)
    {
        var current = new Uri(source, UriKind.Absolute);
        for (var redirect = 0; ; redirect++)
        {
            await ValidateCdnHostAsync(current, cancellationToken);
            using var request = new HttpRequestMessage(HttpMethod.Get, current);
            var response = await _cdnHttp.SendAsync(request, completion, cancellationToken);
            if ((int)response.StatusCode is >= 300 and <= 399 && response.Headers.Location is { } location)
            {
                if (redirect >= 4)
                {
                    response.Dispose();
                    throw new LocalServerException("CDN_REDIRECT", "Слишком много перенаправлений CDN.");
                }
                var next = location.IsAbsoluteUri ? location : new Uri(current, location);
                response.Dispose();
                if (next.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(next.UserInfo) || !string.IsNullOrEmpty(next.Query) || !string.IsNullOrEmpty(next.Fragment))
                    throw new LocalServerException("INVALID_SOURCE", "CDN перенаправил на небезопасный адрес.");
                current = next;
                continue;
            }
            return response;
        }
    }

    private async Task ValidateCdnHostAsync(Uri uri, CancellationToken cancellationToken)
    {
        // Unit tests inject a stub HttpClient. Production passes a dedicated
        // no-redirect client, where DNS pinning checks are mandatory.
        if (!_ownsCdnHttp) return;
        if (uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) || IsBlockedHost(uri.Host))
            throw new LocalServerException("INVALID_SOURCE", "Ссылка должна указывать на публичный CDN.");
        IPAddress[] addresses;
        try { addresses = await Dns.GetHostAddressesAsync(uri.DnsSafeHost, cancellationToken); }
        catch (OperationCanceledException) { throw; }
        catch (SocketException) { throw new LocalServerException("CDN_UNAVAILABLE", "Не удалось определить адрес CDN."); }
        if (addresses.Length == 0 || addresses.Any(address =>
        {
            var candidate = address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;
            return IPAddress.IsLoopback(candidate) || IsPrivateNetwork(candidate);
        }))
            throw new LocalServerException("INVALID_SOURCE", "Ссылка должна указывать на публичный CDN.");
    }

    private async Task DownloadToFileAsync(string source, string destination, CancellationToken cancellationToken)
    {
        if (File.Exists(source))
        {
            File.Copy(source, destination, true);
            return;
        }
        using var response = await SendCdnGetAsync(source, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is > MaxArchiveBytes)
            throw new LocalServerException("ARCHIVE_TOO_LARGE", "ZIP-файл слишком большой.");
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None, 128 * 1024, true);
        var buffer = new byte[128 * 1024];
        long total = 0;
        int read;
        while ((read = await input.ReadAsync(buffer.AsMemory(), cancellationToken)) > 0)
        {
            total += read;
            if (total > MaxArchiveBytes) throw new LocalServerException("ARCHIVE_TOO_LARGE", "ZIP-файл слишком большой.");
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            Emit(LocalServerEvent.ProgressEvent("downloading", null, response.Content.Headers.ContentLength is { } length && length > 0 ? (double)total / length : null, null));
        }
    }

    private static void ValidateArchive(string path)
    {
        using var archive = ZipFile.OpenRead(path);
        long total = 0;
        foreach (var entry in archive.Entries)
        {
            if (entry.Length > MaxEntryBytes || entry.Length > MaxArchiveBytes - total || Path.IsPathRooted(entry.FullName) || entry.FullName.Contains(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) || entry.FullName.Contains("../", StringComparison.Ordinal))
                throw new LocalServerException("INVALID_ARCHIVE", "ZIP содержит небезопасный путь или слишком большой файл.");
            total += entry.Length;
        }
    }

    private static void ExtractArchive(string archivePath, string destination, CancellationToken cancellationToken)
    {
        using var archive = ZipFile.OpenRead(archivePath);
        foreach (var entry in archive.Entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var target = Path.GetFullPath(Path.Combine(destination, entry.FullName));
            if (!target.StartsWith(Path.GetFullPath(destination) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new LocalServerException("INVALID_ARCHIVE", "ZIP содержит выход за пределы каталога установки.");
            if (string.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(target); continue; }
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, true);
            if (!OperatingSystem.IsWindows() && ((entry.ExternalAttributes >> 16 & 0x49) != 0 || Path.GetFileName(target) is "Robust.Server" or "run_server.sh"))
            {
                try { File.SetUnixFileMode(target, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute); } catch (PlatformNotSupportedException) { }
            }
        }
    }

    private static string? FindServerExecutable(string root)
    {
        var names = OperatingSystem.IsWindows()
            ? new[] { "run_server.bat", "Robust.Server.exe", "Robust.Server.dll" }
            : new[] { "Robust.Server", "run_server.sh", "Robust.Server.dll" };
        foreach (var name in names)
        {
            var exact = Directory.EnumerateFiles(root, name, SearchOption.AllDirectories).OrderBy(path => path.Length).FirstOrDefault();
            if (exact is not null) return exact;
        }
        return null;
    }

    private static string ResolveBuildRoot(string staging, string executable)
    {
        var root = Path.GetDirectoryName(executable)!;
        var files = Directory.EnumerateFileSystemEntries(staging).Where(path => !string.Equals(Path.GetFileName(path), "server-build.zip", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (files.Length == 1 && Directory.Exists(files[0]) && root.StartsWith(files[0], StringComparison.OrdinalIgnoreCase))
            return root;
        return root;
    }

    private static async Task<(string TempRoot, string DataPath, string ConfigPath)> PreserveExistingAsync(LocalServerProfile profile, CancellationToken cancellationToken)
    {
        var root = Path.Combine(Path.GetTempPath(), "mados-server-preserve-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var data = Path.Combine(root, "data");
        var config = Path.Combine(root, "server_config.toml");
        if (Directory.Exists(profile.DataPath)) CopyDirectory(profile.DataPath, data, true);
        if (File.Exists(profile.ConfigPath)) File.Copy(profile.ConfigPath, config, true);
        await Task.CompletedTask;
        cancellationToken.ThrowIfCancellationRequested();
        return (root, data, config);
    }

    private LocalServerBackup CreatePersistentBackup(LocalServerProfile profile, string reason, string? sourceRoot = null)
    {
        var stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmssfff", System.Globalization.CultureInfo.InvariantCulture);
        var backupRoot = Path.Combine(_managedRoot, ".backups", profile.Id, stamp + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(backupRoot);
        var config = Path.Combine(backupRoot, "server_config.toml");
        var data = Path.Combine(backupRoot, "data");
        var sourceConfig = sourceRoot is null ? profile.ConfigPath : Path.Combine(sourceRoot, Path.GetFileName(profile.ConfigPath));
        var sourceData = sourceRoot is null ? profile.DataPath : Path.Combine(sourceRoot, Path.GetFileName(profile.DataPath));
        if (reason is "manual-update" or "before-rollback")
        {
            CopyDirectory(sourceRoot ?? profile.InstallPath, backupRoot, true);
            File.WriteAllText(Path.Combine(backupRoot, "mados-profile.json"), JsonSerializer.Serialize(profile));
        }
        if (File.Exists(sourceConfig)) File.Copy(sourceConfig, config, true);
        if ((reason is "manual-update" or "before-rollback") && Directory.Exists(sourceData)) CopyDirectory(sourceData, data, true);
        return new LocalServerBackup(Guid.NewGuid().ToString("N"), profile.Id, config, data, DateTimeOffset.UtcNow, reason);
    }

    private static ProcessStartInfo BuildStartInfo(string executable, string workingDirectory)
    {
        var extension = Path.GetExtension(executable);
        if (extension.Equals(".bat", StringComparison.OrdinalIgnoreCase) || extension.Equals(".cmd", StringComparison.OrdinalIgnoreCase))
            return new ProcessStartInfo { FileName = Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe", Arguments = $"/d /c \"\"{executable}\"\"", WorkingDirectory = workingDirectory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
        if (extension.Equals(".sh", StringComparison.OrdinalIgnoreCase))
            return new ProcessStartInfo { FileName = "/bin/sh", ArgumentList = { executable }, WorkingDirectory = workingDirectory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
        if (extension.Equals(".dll", StringComparison.OrdinalIgnoreCase))
            return new ProcessStartInfo { FileName = "dotnet", ArgumentList = { executable }, WorkingDirectory = workingDirectory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
        return new ProcessStartInfo { FileName = executable, WorkingDirectory = workingDirectory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
    }

    private async Task<bool> WaitForPortAsync(string bind, int port, Process process, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        while (!timeout.IsCancellationRequested && !process.HasExited)
        {
            try
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
                using var response = await http.GetAsync($"http://{(bind == "0.0.0.0" ? "127.0.0.1" : bind)}:{port}/status", timeout.Token);
                if (!response.IsSuccessStatusCode) throw new IOException("status endpoint is not ready");
                await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
                using var document = await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token);
                if (document.RootElement.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
                    return true;
            }
            catch (Exception) { try { await Task.Delay(250, timeout.Token).ConfigureAwait(false); } catch (OperationCanceledException) { break; } }
        }
        return false;
    }

    private async Task ReadOutputAsync(StreamReader reader, string stream, string profileId, StreamWriter writer)
    {
        try
        {
            while (await reader.ReadLineAsync() is { } line)
            {
                var safe = LocalServerConfig.RedactLog(line);
                lock (_logLock)
                {
                    writer.WriteLine($"[{DateTimeOffset.UtcNow:O}] [{stream}] {safe}");
                }
                Emit(LocalServerEvent.Log(profileId, stream, safe));
            }
        }
        catch (ObjectDisposedException) { }
        catch (IOException) { }
    }

    private async Task HandleExitedAsync(Process process, string profileId)
    {
        await _gate.WaitAsync();
        try
        {
            if (!ReferenceEquals(_process, process)) return;
            await process.WaitForExitAsync();
            _status = LocalServerStatus.Stopped;
            _lastError = process.ExitCode == 0 ? null : $"Процесс завершился с кодом {process.ExitCode}.";
            Emit(LocalServerEvent.StatusEvent(profileId, _status, null, _store.Find(profileId)?.Port, _startedAt, _lastError));
            await StopProcessOnlyAsync();
        }
        finally { _gate.Release(); }
    }

    private async Task StopIfActiveAsync(string id, CancellationToken cancellationToken)
    {
        if (_process is { HasExited: false } && string.Equals(id, _activeProfileId, StringComparison.Ordinal))
            await StopAsync(id, cancellationToken);
    }

    private async Task StopProcessOnlyAsync()
    {
        StreamWriter? log;
        Process? process;
        lock (_processLock)
        {
            process = _process;
            _process = null;
            _processInput = null;
            log = _logWriter;
            _logWriter = null;
        }
        if (process is not null)
        {
            try { if (!process.HasExited) process.Kill(true); await process.WaitForExitAsync(); } catch (InvalidOperationException) { }
            try { await Task.WhenAll(_outputTasks).WaitAsync(TimeSpan.FromSeconds(3)); } catch (TimeoutException) { }
            process.Dispose();
        }
        if (log is not null)
        {
            lock (_logLock) { log.Dispose(); }
        }
    }

    private void SetStatus(LocalServerStatus status, string? profileId)
    {
        lock (_processLock) _status = status;
        Emit(LocalServerEvent.StatusEvent(profileId, status, _process is { HasExited: false } p ? p.Id : null, profileId is null ? null : _store.Find(profileId)?.Port, _startedAt, _lastError));
    }

    private void Emit(LocalServerEvent value) { try { Changed?.Invoke(value); } catch { } }

    private string EnsureManaged(string path)
    {
        var resolved = Path.GetFullPath(path);
        if (!resolved.StartsWith(_managedRoot + Path.DirectorySeparatorChar, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new LocalServerException("UNMANAGED_PATH", "Путь должен находиться в каталоге локальных серверов Mados.");
        var current = new DirectoryInfo(resolved);
        while (current is not null && current.FullName.Length >= _managedRoot.Length)
        {
            if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new LocalServerException("UNMANAGED_PATH", "Символические ссылки в управляемом каталоге запрещены.");
            current = current.Parent;
        }
        return resolved;
    }

    private static CdnBuildVariant SelectVariant(IReadOnlyList<CdnBuildVariant> variants, string? selectedUrl)
    {
        if (!string.IsNullOrWhiteSpace(selectedUrl))
            return variants.FirstOrDefault(v => string.Equals(v.Url, selectedUrl, StringComparison.OrdinalIgnoreCase)) ?? throw new LocalServerException("BUILD_NOT_FOUND", "Выбранная сборка не найдена.");
        var platform = CurrentPlatform();
        var architecture = CurrentArchitecture();
        return variants.FirstOrDefault(v => string.Equals(v.Platform, platform, StringComparison.OrdinalIgnoreCase) && string.Equals(v.Architecture, architecture, StringComparison.OrdinalIgnoreCase))
            ?? variants.FirstOrDefault(v => string.Equals(v.Platform, platform, StringComparison.OrdinalIgnoreCase))
            ?? variants[0];
    }

    private static List<CdnBuildVariant> ParseCdnPage(string source, string html)
    {
        var result = new List<CdnBuildVariant>();
        foreach (Match match in Regex.Matches(html, "<a[^>]+href\\s*=\\s*[\\\"'](?<url>[^\\\"']+\\.zip(?:\\?[^\\\"']*)?)[\\\"'][^>]*>(?<label>[^<]*)</a>(?<tail>[^<]{0,100})", RegexOptions.IgnoreCase))
        {
            var raw = WebUtility.HtmlDecode(match.Groups["url"].Value);
            if (!Uri.TryCreate(new Uri(source), raw, out var url) || !string.Equals(url.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)) continue;
            var label = WebUtility.HtmlDecode(match.Groups["label"].Value).Trim();
            var size = ParseSize(match.Groups["tail"].Value);
            result.Add(BuildVariant(url.AbsoluteUri, size, label));
        }
        return result.GroupBy(v => v.Url, StringComparer.OrdinalIgnoreCase).Select(g => g.First()).ToList();
    }

    private static long? ParseSize(string value)
    {
        var match = Regex.Match(value, @"(?<value>[0-9]+(?:[.,][0-9]+)?)\s*(?<unit>KiB|MiB|GiB)", RegexOptions.IgnoreCase);
        if (!match.Success || !double.TryParse(match.Groups["value"].Value.Replace(',', '.'), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var number)) return null;
        var multiplier = match.Groups["unit"].Value.ToLowerInvariant() switch { "gib" => 1024d * 1024d * 1024d, "mib" => 1024d * 1024d, _ => 1024d };
        return checked((long)(number * multiplier));
    }

    private static CdnBuildVariant BuildVariant(string url, long? size, string? hint)
    {
        var text = (url + " " + hint).ToLowerInvariant();
        var platform = text.Contains("windows") || text.Contains("win-") || text.Contains("win_") ? "windows" : text.Contains("mac") || text.Contains("osx") ? "macos" : text.Contains("linux") ? "linux" : null;
        var architecture = text.Contains("arm64") || text.Contains("aarch64") ? "arm64" : text.Contains("x64") || text.Contains("amd64") ? "x64" : null;
        var version = Regex.Match(url, @"/version/(?<v>[^/]+)/", RegexOptions.IgnoreCase).Groups["v"].Value;
        if (string.IsNullOrWhiteSpace(version)) version = Regex.Match(url, @"(?<![0-9])v?(?<v>[0-9]+(?:\.[0-9]+){1,3})(?![0-9])", RegexOptions.IgnoreCase).Groups["v"].Value;
        return new CdnBuildVariant(url, string.IsNullOrWhiteSpace(version) ? null : version, platform, architecture, size, null);
    }

    private static string ValidateSource(string source)
    {
        if (string.IsNullOrWhiteSpace(source)) throw new LocalServerException("INVALID_SOURCE", "Укажите CDN-ссылку или ZIP-файл.");
        if (File.Exists(source)) return Path.GetFullPath(source);
        if (!Uri.TryCreate(source.Trim(), UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment))
            throw new LocalServerException("INVALID_SOURCE", "Поддерживаются только публичные HTTPS-ссылки CDN или локальный ZIP.");
        if (IsBlockedHost(uri.Host))
            throw new LocalServerException("INVALID_SOURCE", "Ссылка должна указывать на публичный CDN.");
        return uri.AbsoluteUri;
    }

    private static bool IsBlockedHost(string host)
    {
        return string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".local", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".internal", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".home", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".lan", StringComparison.OrdinalIgnoreCase)
            || IPAddress.TryParse(host, out var address) && (IPAddress.IsLoopback(address) || IsPrivateNetwork(address));
    }

    private static string SafeSource(string source) => File.Exists(source) ? "file://local" : new Uri(source).GetLeftPart(UriPartial.Path);
    private static bool IsPrivateNetwork(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        if (bytes.Length == 4)
            return bytes[0] == 0 || bytes[0] == 10 || bytes[0] == 127 || bytes[0] >= 224 || bytes[0] == 100 && bytes[1] is >= 64 and <= 127 || bytes[0] == 169 && bytes[1] == 254 || bytes[0] == 172 && bytes[1] is >= 16 and <= 31 || bytes[0] == 192 && bytes[1] == 168;
        return address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || bytes[0] == 0xfc || bytes[0] == 0xfd;
    }
    private static string? NormalizeName(string? name) => string.IsNullOrWhiteSpace(name) ? null : name.Trim().Length > 120 ? name.Trim()[..120] : name.Trim();
    private static string InferName(string source) => (Path.GetFileNameWithoutExtension(source.TrimEnd('/', '\\')) is { Length: > 0 } name ? name : "Local SS14 Server");
    private static string CurrentPlatform() => OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : "linux";
    private static string CurrentArchitecture() => RuntimeInformation.OSArchitecture switch { Architecture.Arm64 => "arm64", _ => "x64" };
    private static string DefaultConfig(int port, string bind) => $"[net]\nport = {port}\nbind = \"{bind}\"\n\n[game]\nmaxplayers = 100\n";
    private static string Redact(string value) => Regex.Replace(value, "(?i)(token|password|secret|apikey)\\s*[=:]\\s*[^\\s]+", "$1=[redacted]");
    private static void TryDeleteFile(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { } }
    private static void TryDeleteDirectory(string path) { try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { } }
    private static void CopyDirectory(string source, string destination, bool overwrite)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.EnumerateFiles(source)) File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), overwrite);
        foreach (var directory in Directory.EnumerateDirectories(source)) CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)), overwrite);
    }
}

public sealed record CdnInspectResult(string Source, string Kind, IReadOnlyList<CdnBuildVariant> Variants);
public sealed record CdnBuildVariant(string Url, string? Version, string? Platform, string? Architecture, long? SizeBytes, DateTimeOffset? PublishedAt);
public enum LocalServerStatus { Idle, Downloading, Extracting, Ready, Starting, Running, Stopping, Stopped, Error }
public sealed record LocalServerRuntimeStatus(LocalServerStatus Status, string? ProfileId, int? Pid, DateTimeOffset? StartedAt, string? Error, int? Port);
public sealed class LocalServerException : Exception
{
    public LocalServerException(string code, string userMessage) : base(userMessage) => Code = code;
    public string Code { get; }
}
public sealed record LocalServerEvent(string Kind, string? ProfileId, LocalServerStatus? Status, int? Pid, int? Port, DateTimeOffset? StartedAt, string? Message, string? Stream, double? Progress)
{
    public static LocalServerEvent StatusEvent(string? profileId, LocalServerStatus status, int? pid, int? port, DateTimeOffset? startedAt, string? message) => new("status", profileId, status, pid, port, startedAt, message, null, null);
    public static LocalServerEvent Log(string profileId, string stream, string message) => new("log", profileId, null, null, null, null, message, stream, null);
    public static LocalServerEvent ProgressEvent(string phase, string? profileId, double? progress, string? message) => new(phase, profileId, null, null, null, null, message, null, progress);
    public static LocalServerEvent ConfigChanged(string profileId) => new("configChanged", profileId, null, null, null, null, null, null, null);
}
