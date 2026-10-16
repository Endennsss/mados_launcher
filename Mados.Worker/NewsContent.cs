#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SS14.Launcher.Worker;

public sealed record NewsEntry(string Title, string Link, DateTime? Date, string Source, string? Summary, string? Body = null, string? Version = null, bool Prerelease = false, bool IsLatestStable = false);

public static class NewsContent
{
    public static IReadOnlyList<NewsEntry> SelectForFeed(IEnumerable<NewsEntry> entries)
    {
        var items = entries.Where(item => !string.IsNullOrWhiteSpace(item.Link))
            .GroupBy(item => item.Link, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.OrderByDescending(item => item.IsLatestStable).ThenByDescending(item => item.Date ?? DateTime.MinValue).First())
            .OrderByDescending(item => item.Date ?? DateTime.MinValue).ToList();
        var stable = items.FirstOrDefault(item => item.IsLatestStable && !item.Prerelease)
            ?? items.FirstOrDefault(item => item.Version != null && !item.Prerelease && item.Source == "GitHub · Mados Launcher");
        if (stable == null) return items.Take(20).ToArray();
        return new[] { stable }.Concat(items.Where(item => item != stable)).Take(20).ToArray();
    }
    public static string? LimitBody(string? value) => string.IsNullOrWhiteSpace(value) ? null : value[..Math.Min(value.Length, 64000)].Trim();

    public static string? PlainText(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        value = value[..Math.Min(value.Length, 256000)];
        value = Regex.Replace(value, @"<(script|style)\b[^>]*>.*?</\1\s*>", "", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        value = Regex.Replace(value, @"</?(p|div|h[1-6]|li|br)\b[^>]*>", "\n", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, "<[^>]+>", "");
        value = WebUtility.HtmlDecode(value).Replace("\r", "");
        value = Regex.Replace(value, @"[^\S\n]+", " ");
        value = Regex.Replace(value, @"\n\s*\n", "\n\n");
        return LimitBody(value);
    }

    public static string? Summary(string? value)
    {
        var plain = PlainText(value);
        if (plain == null) return null;
        plain = Regex.Replace(plain, @"\s+", " ").Trim();
        return plain.Length > 220 ? plain[..217] + "…" : plain;
    }

    public static NewsEntry? FromGitHub(JsonElement release)
    {
        if (release.TryGetProperty("draft", out var draft) && draft.ValueKind == JsonValueKind.True) return null;
        var link = Text(release, "html_url");
        if (!Uri.TryCreate(link, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.Host != "github.com" || !string.IsNullOrEmpty(uri.UserInfo) || !uri.AbsolutePath.StartsWith("/Endennsss/mados_launcher/releases/tag/", StringComparison.OrdinalIgnoreCase)) return null;
        var version = Text(release, "tag_name");
        var body = LimitBody(Text(release, "body"));
        var dateText = Text(release, "published_at") ?? Text(release, "created_at");
        DateTime? date = DateTime.TryParse(dateText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed) ? parsed : null;
        return new NewsEntry(Text(release, "name") ?? version ?? "Mados Launcher", link!, date, "GitHub · Mados Launcher", Summary(body), body, version,
            release.TryGetProperty("prerelease", out var preview) && preview.ValueKind == JsonValueKind.True);
    }

    private static string? Text(JsonElement element, string key) => element.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
