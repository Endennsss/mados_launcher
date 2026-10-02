using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.IO;
using System.Text.Json;
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
        var tags = status.Tags?.Where(tag => !string.IsNullOrWhiteSpace(tag)).ToArray() ?? Array.Empty<string>();
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
        return tags.Where(tag => tag != null && tag.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            .Select(tag => tag[prefix.Length..].Trim()).FirstOrDefault(value => value.Length > 0);
    }
}

public static class ServerStatusProbe
{
    public static async Task<ServerStatusSnapshot?> FetchAsync(HttpClient http, string address, CancellationToken cancel)
    {
        var safeAddress = PresenceAddress.Sanitize(address);
        if (safeAddress == null || !UriHelper.TryParseSs14Uri(safeAddress, out var parsedAddress))
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
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or InvalidOperationException or UriFormatException or JsonException or IOException)
        {
            return null;
        }
    }
}
