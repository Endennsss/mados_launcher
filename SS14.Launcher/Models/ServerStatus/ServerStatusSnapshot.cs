using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading;
using System.Threading.Tasks;
using SS14.Launcher.Api;

namespace SS14.Launcher.Models.ServerStatus;

/// <summary>
/// A status response enriched with the round-trip time measured for this
/// particular server. The launcher never infers map or mode from a server
/// name; those values must be explicit status tags.
/// </summary>
public sealed record ServerStatusSnapshot(
    string? Name,
    int PlayerCount,
    int SoftMaxPlayerCount,
    string? RoundStartTime,
    string? RunLevel,
    string[] Tags,
    long? PingMs,
    string? Language,
    string? Map,
    string? Mode)
{
    public static ServerStatusSnapshot FromStatus(ServerApi.ServerStatus status, long? pingMs)
    {
        var tags = status.Tags ?? Array.Empty<string>();
        return new ServerStatusSnapshot(
            status.Name,
            Math.Max(0, status.PlayerCount),
            Math.Max(0, status.SoftMaxPlayerCount),
            status.RoundStartTime,
            status.RunLevel?.ToString(),
            tags,
            pingMs,
            FindTagValue(tags, "lang:"),
            FindTagValue(tags, "map:"),
            FindTagValue(tags, "mode:"));
    }

    public static string? FindTagValue(IEnumerable<string> tags, string prefix)
    {
        return tags.FirstOrDefault(tag => tag.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))?[prefix.Length..].Trim();
    }
}

public static class ServerStatusProbe
{
    public static async Task<ServerStatusSnapshot?> FetchAsync(HttpClient http, string address, CancellationToken cancel)
    {
        if (!UriHelper.TryParseSs14Uri(address, out var parsedAddress))
            return null;

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeout.CancelAfter(ConfigConstants.ServerStatusTimeout);
        var stopwatch = Stopwatch.StartNew();

        try
        {
            var status = await http.GetFromJsonAsync<ServerApi.ServerStatus>(
                UriHelper.GetServerStatusAddress(parsedAddress), timeout.Token);
            return status == null ? null : ServerStatusSnapshot.FromStatus(status, Math.Max(0, stopwatch.ElapsedMilliseconds));
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or InvalidOperationException or UriFormatException)
        {
            return null;
        }
    }
}
