using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Serilog;
using SS14.Launcher.Api;
using SS14.Launcher.Utility;

namespace SS14.Launcher.Models.ServerStatus;

public sealed record ServerCatalogHub(UrlFallbackSet Urls, string Address);

public sealed record ServerCatalogEntry(
    string Address, string? Name, int PlayerCount, int SoftMaxPlayerCount,
    string? RoundStartTime, string? RunLevel, string[] Tags, string Status,
    string HubAddress, long? PingMs, string? Language, string? Map, string? Mode);

public sealed record ServerCatalogResult(
    ServerCatalogEntry[] Servers, string[] FailedHubs, bool PartialError,
    bool Refreshing, long Revision, bool Stale = false);

/// <summary>
/// A request starts at most one bounded refresh. Hub results are usable before
/// independent ping measurements finish; returning to the catalog reuses them.
/// There is no timer that polls servers after a refresh has completed.
/// </summary>
public sealed class ServerCatalogCache : IAsyncDisposable
{
    private readonly HttpClient _http;
    private readonly HubApi _hub;
    private readonly Action<ServerCatalogResult> _updated;
    private readonly TimeProvider _clock;
    private readonly object _gate = new();
    private readonly CancellationTokenSource _stop = new();
    private ServerCatalogResult _snapshot = new([], [], false, false, 0);
    private Task<ServerCatalogResult> _refresh = Task.FromResult(new ServerCatalogResult([], [], false, false, 0));
    private DateTimeOffset? _fetchedAt;
    private string? _hubKey;
    private bool _disposed;

    public ServerCatalogCache(HttpClient http, Action<ServerCatalogResult> updated, TimeProvider? clock = null)
    {
        _http = http;
        _hub = new HubApi(http);
        _updated = updated;
        _clock = clock ?? TimeProvider.System;
    }

    public Task<ServerCatalogResult> Completion { get { lock (_gate) return _refresh; } }

    public ServerCatalogResult Get(ServerCatalogHub[] hubs, bool forceRefresh = false)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (!_refresh.IsCompleted) return _snapshot;
            var key = string.Join('\n', hubs.SelectMany(h => h.Urls.Urls));
            var lifetime = TimeSpan.FromSeconds(_snapshot.FailedHubs.Length > 0 ? 5 : 30);
            if (!forceRefresh && key == _hubKey && _fetchedAt is { } fetched && _clock.GetUtcNow() - fetched < lifetime)
                return _snapshot;

            _hubKey = key;
            var previous = _snapshot;
            _snapshot = _snapshot with { Refreshing = true, Revision = _snapshot.Revision + 1 };
            _refresh = Task.Run(() => RefreshAsync(hubs, previous, _stop.Token));
            return _snapshot;
        }
    }

    private async Task<ServerCatalogResult> RefreshAsync(ServerCatalogHub[] hubs, ServerCatalogResult previous, CancellationToken cancel)
    {
        var stopwatch = Stopwatch.StartNew();
        var sources = new ServerCatalogEntry[]?[hubs.Length];
        var failures = new bool[hubs.Length];
        try
        {
            using var hubTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            hubTimeout.CancelAfter(TimeSpan.FromSeconds(15));
            await Task.WhenAll(hubs.Select(async (source, index) =>
            {
                ServerCatalogEntry[]? entries = null;
                try
                {
                    var received = await _hub.GetServers(source.Urls, hubTimeout.Token);
                    entries = received.Select(entry =>
                    {
                        var status = ServerStatusSnapshot.FromStatus(entry.StatusData, null);
                        return new ServerCatalogEntry(entry.Address, status.Name, status.PlayerCount, status.SoftMaxPlayerCount,
                            status.RoundStartTime, status.RunLevel, status.Tags, "online", source.Address, null,
                            status.Language, status.Map, status.Mode);
                    }).ToArray();
                }
                catch (OperationCanceledException) when (cancel.IsCancellationRequested) { throw; }
                catch (Exception error)
                {
                    Log.Warning(error, "Failed to fetch hub server list from {Hub}", source.Address);
                }
                lock (_gate)
                {
                    cancel.ThrowIfCancellationRequested();
                    sources[index] = entries;
                    failures[index] = entries is null;
                    // Merge in configured hub priority, not response arrival order.
                    var servers = Merge(sources);
                    var failed = hubs.Where((_, i) => failures[i]).Select(h => h.Address).ToArray();
                    if (entries is not null)
                    {
                        Log.Debug("Catalog hub ready: {Count} servers in {ElapsedMs} ms", servers.Length, stopwatch.ElapsedMilliseconds);
                        Publish(servers, failed, true);
                    }
                }
            }));

            var allFailed = sources.All(source => source is null) && hubs.Length > 0;
            var failedHubs = hubs.Where((_, i) => failures[i]).Select(h => h.Address).ToArray();
            var catalog = (allFailed ? previous.Servers : Merge(sources)).ToDictionary(server => server.Address, StringComparer.OrdinalIgnoreCase);
            if (!allFailed)
            {
                using var pingTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
                pingTimeout.CancelAfter(TimeSpan.FromSeconds(15));
                var lastPublish = Stopwatch.GetTimestamp();
                try
                {
                    await Parallel.ForEachAsync(catalog.Values.ToArray(), new ParallelOptions
                    {
                        MaxDegreeOfParallelism = 12,
                        CancellationToken = pingTimeout.Token
                    }, async (server, token) =>
                    {
                        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
                        timeout.CancelAfter(ConfigConstants.ServerStatusTimeout);
                        var ping = await ServerPingProbe.MeasureAsync(_http, server.Address, timeout.Token);
                        lock (_gate)
                        {
                            cancel.ThrowIfCancellationRequested();
                            catalog[server.Address] = server with { PingMs = ping };
                            // Batch updates: hundreds of servers must not produce
                            // hundreds of full-list IPC messages / React renders.
                            if (Stopwatch.GetElapsedTime(lastPublish) >= TimeSpan.FromMilliseconds(250))
                            {
                                Publish(catalog.Values.ToArray(), failedHubs, true);
                                lastPublish = Stopwatch.GetTimestamp();
                            }
                        }
                    });
                }
                catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
                {
                    Log.Debug("Catalog ping budget exhausted; unfinished probes remain unknown");
                }
            }
            lock (_gate)
            {
                cancel.ThrowIfCancellationRequested();
                _fetchedAt = _clock.GetUtcNow();
                Publish(catalog.Values.ToArray(), failedHubs, false, allFailed && catalog.Count > 0);
                Log.Debug("Catalog refresh complete: {Count} servers in {ElapsedMs} ms", catalog.Count, stopwatch.ElapsedMilliseconds);
                return _snapshot;
            }
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            lock (_gate) return _snapshot;
        }
        catch (Exception error)
        {
            Log.Error(error, "Catalog refresh failed");
            lock (_gate)
            {
                if (!cancel.IsCancellationRequested)
                    Publish(previous.Servers, hubs.Select(h => h.Address).ToArray(), false, previous.Servers.Length > 0);
                return _snapshot;
            }
        }
    }

    private static ServerCatalogEntry[] Merge(IEnumerable<ServerCatalogEntry[]?> sources)
    {
        var unique = new Dictionary<string, ServerCatalogEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var source in sources)
            foreach (var server in source ?? [])
                unique.TryAdd(server.Address, server);
        return unique.Values.ToArray();
    }

    // All publications and revision increments run under _gate.
    private void Publish(ServerCatalogEntry[] servers, string[] failedHubs, bool refreshing, bool stale = false)
    {
        _snapshot = new(servers, failedHubs, failedHubs.Length > 0 && servers.Length > 0,
            refreshing, _snapshot.Revision + 1, stale);
        _updated(_snapshot);
    }

    public async ValueTask DisposeAsync()
    {
        Task refresh;
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            refresh = _refresh;
        }
        await _stop.CancelAsync();
        await refresh;
        _stop.Dispose();
    }
}
