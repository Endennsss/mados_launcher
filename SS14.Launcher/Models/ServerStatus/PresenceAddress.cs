using System;

namespace SS14.Launcher.Models.ServerStatus;

/// <summary>
/// Removes credentials and query data before a server address can cross the
/// worker boundary into Electron or an external presence provider.
/// </summary>
public static class PresenceAddress
{
    public static string? Sanitize(string? address)
    {
        if (string.IsNullOrWhiteSpace(address))
            return null;

        if (UriHelper.TryParseSs14Uri(address.Trim(), out var parsed))
        {
            var builder = new UriBuilder(parsed)
            {
                UserName = string.Empty,
                Password = string.Empty,
                Query = string.Empty,
                Fragment = string.Empty
            };
            return builder.Uri.AbsoluteUri.TrimEnd('/');
        }

        return null;
    }
}
