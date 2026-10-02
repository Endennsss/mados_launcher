using System;
using System.Diagnostics;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace SS14.Launcher.Models.ServerStatus;

/// <summary>
/// Measures the HTTP round-trip to one server's status endpoint. The hub list
/// request is intentionally not used here: its duration is shared by every
/// entry and therefore cannot represent a server-specific ping.
/// </summary>
public static class ServerPingProbe
{
    public static async Task<long?> MeasureAsync(HttpClient http, string address, CancellationToken cancel)
    {
        try
        {
            if (!UriHelper.TryParseSs14Uri(address, out var parsedAddress))
                return null;

            var stopwatch = Stopwatch.StartNew();
            using var response = await http.GetAsync(
                UriHelper.GetServerStatusAddress(parsedAddress),
                HttpCompletionOption.ResponseHeadersRead,
                cancel);

            return response.IsSuccessStatusCode
                ? Math.Max(0, stopwatch.ElapsedMilliseconds)
                : null;
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or InvalidOperationException or UriFormatException)
        {
            return null;
        }
    }
}
