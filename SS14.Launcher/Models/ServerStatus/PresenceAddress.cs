using System;
using System.Text.RegularExpressions;

namespace SS14.Launcher.Models.ServerStatus;

/// <summary>
/// Removes credentials and query data before a server address can cross the
/// worker boundary into Electron or an external presence provider.
/// </summary>
public static class PresenceAddress
{
    private static readonly Regex SensitiveArgument = new(
        @"(?<key>token|password|secret|access_token|refresh_token)=[^\s&]+",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static string? Sanitize(string? address)
    {
        if (string.IsNullOrWhiteSpace(address))
            return null;

        if (UriHelper.TryParseSs14Uri(address.Trim(), out var parsed))
            return SanitizeUri(parsed);

        return null;
    }

    public static string SanitizeForLog(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return string.Empty;

        var trimmed = value.Trim();
        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var rawUri))
            return SanitizeUri(rawUri);

        var separator = value.IndexOf('=');
        if (separator > 0 && Uri.TryCreate(value[(separator + 1)..], UriKind.Absolute, out var embedded))
            return $"{value[..(separator + 1)]}{SanitizeUri(embedded)}";

        if (value.Contains("://", StringComparison.Ordinal) || value.Contains('?', StringComparison.Ordinal))
            return "[invalid address]";

        return SensitiveArgument.Replace(value, "${key}=[redacted]");
    }

    private static string SanitizeUri(Uri parsed)
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
}
