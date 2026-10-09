#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Text.RegularExpressions;
using Tomlyn;
using Tomlyn.Model;

namespace SS14.Launcher.Worker;

/// <summary>Parses real TOML and keeps protected credentials inside the worker.</summary>
public static class LocalServerConfig
{
    public const string SecretPlaceholder = "<stored by Mados>";
    private static readonly Regex SecretKey = new("password|passwd|token|secret|credential|api.?key|private.?key|connection.?string", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static TomlTable Parse(string text)
    {
        if (text.Length > 1024 * 1024)
            throw new LocalServerException("INVALID_TOML", "Конфигурация превышает 1 МиБ.");
        var syntax = Toml.Parse(text);
        if (syntax.HasErrors)
        {
            var diagnostic = syntax.Diagnostics.First();
            // Do not include arbitrary source lines: they can contain credentials.
            throw new LocalServerException("INVALID_TOML", $"Ошибка TOML. Строка {diagnostic.Span.Start.Line + 1}. Проверьте синтаксис.");
        }
        return syntax.ToModel();
    }

    public static string ProtectLocal(string text, int port, string bind = "127.0.0.1")
    {
        ValidateBind(bind);
        ValidatePort(port);
        var table = Parse(text);
        var net = Section(table, "net");
        net["port"] = (long)port;
        net["bindto"] = bind;
        net["bind"] = bind;
        var status = Section(table, "status");
        status["enabled"] = true;
        status["bind"] = $"{bind}:{port}";
        Section(table, "hub")["advertise"] = false;
        Section(table, "log")["path"] = "logs";
        return Toml.FromModel(table);
    }

    public static LocalServerConfiguration Read(string text, string name, int fallbackPort)
    {
        var table = Parse(text);
        var net = Section(table, "net");
        var game = Section(table, "game");
        var auth = Section(table, "auth");
        var configuration = new LocalServerConfiguration(name, String(net, "hostname"), String(net, "bindto") ?? "127.0.0.1",
            Integer(net, "port") ?? fallbackPort, Integer(game, "maxplayers"), String(auth, "mode") ?? "1", "");
        RedactTable(table);
        return configuration with { RawToml = Toml.FromModel(table) };
    }

    public static string Merge(string original, LocalServerConfiguration input)
    {
        var source = Parse(original);
        var target = Parse(input.RawToml);
        RestoreSecrets(source, target);
        var net = Section(target, "net");
        if (input.Hostname is not null) net["hostname"] = input.Hostname;
        var game = Section(target, "game");
        if (input.MaxPlayers is { } max)
        {
            if (max is < 1 or > 65535) throw new LocalServerException("INVALID_PARAMS", "Лимит игроков должен быть от 1 до 65535.");
            game["maxplayers"] = (long)max;
        }
        if (input.AuthMode is not null)
        {
            var authMode = input.AuthMode.Trim() switch
            {
                "Disabled" => "0",
                "Optional" => "1",
                "Required" => "2",
                var numeric => numeric
            };
            if (!int.TryParse(authMode, out var mode) || mode is < 0 or > 2)
                throw new LocalServerException("INVALID_PARAMS", "Режим авторизации должен быть 0, 1 или 2.");
            Section(target, "auth")["mode"] = (long)mode;
        }
        return ProtectLocal(Toml.FromModel(target), input.Port, input.BindAddress);
    }

    public static string MergeRaw(string original, string edited, int fallbackPort)
    {
        var target = Parse(edited);
        RestoreSecrets(Parse(original), target);
        var net = Section(target, "net");
        return ProtectLocal(Toml.FromModel(target), Integer(net, "port") ?? fallbackPort);
    }

    public static void ValidateBind(string bind)
    {
        if (bind != "127.0.0.1")
            throw new LocalServerException("INVALID_PARAMS", "В этой версии поддерживается только адрес 127.0.0.1.");
    }

    public static void ValidatePort(int port)
    {
        if (port is < 1 or > 65535) throw new LocalServerException("INVALID_PARAMS", "Порт должен быть от 1 до 65535.");
    }

    public static string RedactLog(string value)
    {
        var clean = Regex.Replace(value, @"\x1B\[[0-?]*[ -/]*[@-~]", "");
        clean = Regex.Replace(clean, @"(?i)(authorization\s*:\s*)(?:bearer\s+)?\S+", "$1[redacted]");
        clean = Regex.Replace(clean, @"(?i)([\w.-]*(?:password|passwd|token|secret|credential|api.?key|private.?key)[\w.-]*\s*[=:]\s*)(?:""[^""]*""|'[^']*'|[^\s,;]+)", "$1[redacted]");
        clean = Regex.Replace(clean, @"https?://[^\s""<>]+", match =>
        {
            if (!Uri.TryCreate(match.Value, UriKind.Absolute, out var uri)) return "[url]";
            return new UriBuilder(uri) { UserName = "", Password = "", Query = "", Fragment = "" }.Uri.GetLeftPart(UriPartial.Path);
        });
        return clean.Length <= 16000 ? clean : clean[..16000];
    }

    private static TomlTable Section(TomlTable table, string name)
    {
        if (table.TryGetValue(name, out var existing))
        {
            if (existing is TomlTable section) return section;
            throw new LocalServerException("INVALID_TOML", $"Секция {name} должна быть таблицей TOML.");
        }
        var created = new TomlTable();
        table[name] = created;
        return created;
    }

    private static string? String(TomlTable table, string key) => table.TryGetValue(key, out var value) ? value?.ToString() : null;
    private static int? Integer(TomlTable table, string key) => table.TryGetValue(key, out var value) && value is long number && number >= int.MinValue && number <= int.MaxValue ? (int)number : null;

    private static void RedactTable(TomlTable table)
    {
        foreach (var key in table.Keys.ToArray())
        {
            if (SecretKey.IsMatch(key)) table[key] = SecretPlaceholder;
            else if (table[key] is TomlTable child) RedactTable(child);
            else if (table[key] is TomlTableArray children) foreach (var item in children) RedactTable(item);
            else if (table[key] is string text && Uri.TryCreate(text, UriKind.Absolute, out var uri) && (!string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query))) table[key] = SecretPlaceholder;
        }
    }

    private static void RestoreSecrets(TomlTable original, TomlTable edited)
    {
        foreach (var key in original.Keys)
        {
            var old = original[key];
            if (SecretKey.IsMatch(key) || old is string text && Uri.TryCreate(text, UriKind.Absolute, out var uri) && (!string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query)))
                edited[key] = old;
            else if (old is TomlTable child)
                RestoreSecrets(child, Section(edited, key));
            else if (old is TomlTableArray children)
            {
                if (!edited.TryGetValue(key, out var newChildren) || newChildren is not TomlTableArray targets || targets.Count != children.Count)
                    edited[key] = children;
                else for (var i = 0; i < children.Count; i++) RestoreSecrets(children[i], targets[i]);
            }
        }
    }
}

public sealed record LocalServerConfiguration(string? Name, string? Hostname, string BindAddress, int Port, int? MaxPlayers, string? AuthMode, string RawToml);
