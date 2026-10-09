#nullable enable

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Dapper;
using Microsoft.Data.Sqlite;
using SS14.Launcher.Models.ServerStatus;

namespace SS14.Launcher.Worker;

/// <summary>
/// Persists private server notes outside the launcher's existing settings DB.
/// The account id is part of the primary key so switching accounts cannot leak
/// a note from another profile into the renderer.
/// </summary>
public sealed class ServerNotesStore
{
    public const int MaxTextLength = 4_000;
    private const int MaxAddressLength = 2_048;

    private readonly string _databasePath;
    private readonly object _gate = new();

    public ServerNotesStore(string? databasePath = null)
    {
        _databasePath = databasePath ?? Path.Combine(LauncherPaths.DirUserData, "server-notes.db");
        var directory = Path.GetDirectoryName(_databasePath);
        if (!string.IsNullOrEmpty(directory))
            Directory.CreateDirectory(directory);

        Initialize();
    }

    public IReadOnlyList<ServerNote> List(Guid accountId)
    {
        EnsureAccount(accountId);

        lock (_gate)
        {
            using var connection = OpenConnection();
            return connection.Query<ServerNoteRow>(
                    "SELECT Address, Text, UpdatedAtUtc FROM ServerNote WHERE AccountId = @AccountId ORDER BY UpdatedAtUtc DESC, Address COLLATE NOCASE ASC",
                    new { AccountId = accountId.ToString() })
                .Select(ToNote)
                .ToArray();
        }
    }

    public ServerNote? Find(Guid accountId, string address)
    {
        EnsureAccount(accountId);
        var normalizedAddress = NormalizeAddress(address);

        lock (_gate)
        {
            using var connection = OpenConnection();
            var row = connection.QuerySingleOrDefault<ServerNoteRow>(
                "SELECT Address, Text, UpdatedAtUtc FROM ServerNote WHERE AccountId = @AccountId AND Address = @Address",
                new { AccountId = accountId.ToString(), Address = normalizedAddress });
            return row is null ? null : ToNote(row);
        }
    }

    /// <summary>
    /// Adds or replaces a note. An empty note is treated as a clear operation
    /// so an abandoned editor cannot leave an empty row in the database.
    /// </summary>
    public ServerNote? Upsert(Guid accountId, string address, string text)
    {
        EnsureAccount(accountId);
        var normalizedAddress = NormalizeAddress(address);
        var normalizedText = NormalizeText(text);
        if (normalizedText.Length == 0)
        {
            Remove(accountId, normalizedAddress);
            return null;
        }

        var updatedAt = DateTimeOffset.UtcNow;
        lock (_gate)
        {
            using var connection = OpenConnection();
            connection.Execute(@"
INSERT INTO ServerNote(AccountId, Address, Text, UpdatedAtUtc)
VALUES (@AccountId, @Address, @Text, @UpdatedAtUtc)
ON CONFLICT(AccountId, Address) DO UPDATE SET
    Text = excluded.Text,
    UpdatedAtUtc = excluded.UpdatedAtUtc;",
                new
                {
                    AccountId = accountId.ToString(),
                    Address = normalizedAddress,
                    Text = normalizedText,
                    UpdatedAtUtc = FormatTimestamp(updatedAt)
                });
        }

        return new ServerNote(normalizedAddress, normalizedText, updatedAt);
    }

    public bool Remove(Guid accountId, string address)
    {
        EnsureAccount(accountId);
        var normalizedAddress = NormalizeAddress(address);

        lock (_gate)
        {
            using var connection = OpenConnection();
            return connection.Execute(
                       "DELETE FROM ServerNote WHERE AccountId = @AccountId AND Address = @Address",
                       new { AccountId = accountId.ToString(), Address = normalizedAddress }) > 0;
        }
    }

    public static string NormalizeAddress(string address)
    {
        if (string.IsNullOrWhiteSpace(address))
            throw new ArgumentException("A server address is required.", nameof(address));

        var value = address.Trim();
        if (value.Length > MaxAddressLength || !UriHelper.TryParseSs14Uri(value, out var parsed))
            throw new ArgumentException("The server address is invalid.", nameof(address));

        try
        {
            var scheme = parsed.Scheme.ToLowerInvariant();
            var defaultPort = scheme == UriHelper.SchemeSs14 ? Global.DefaultServerPort : 443;
            var builder = new UriBuilder(parsed)
            {
                Scheme = scheme,
                Host = parsed.Host.ToLowerInvariant(),
                // Explicit default ports are equivalent to omitted ports for
                // SS14 links and should resolve to one note key.
                Port = parsed.Port == defaultPort ? -1 : parsed.Port,
                Path = parsed.AbsolutePath.TrimEnd('/'),
                Query = string.Empty,
                Fragment = string.Empty,
                UserName = string.Empty,
                Password = string.Empty
            };

            var normalized = builder.Uri.AbsoluteUri.TrimEnd('/');
            return normalized.Length <= MaxAddressLength
                ? normalized
                : throw new ArgumentException("The server address is invalid.", nameof(address));
        }
        catch (UriFormatException error)
        {
            throw new ArgumentException("The server address is invalid.", nameof(address), error);
        }
    }

    private static string NormalizeText(string text)
    {
        if (text is null)
            throw new ArgumentNullException(nameof(text));

        var normalized = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Trim();
        if (normalized.Length > MaxTextLength)
            throw new ArgumentException($"A server note cannot exceed {MaxTextLength} characters.", nameof(text));
        return normalized;
    }

    private static void EnsureAccount(Guid accountId)
    {
        if (accountId == Guid.Empty)
            throw new ArgumentException("An account is required for server notes.", nameof(accountId));
    }

    private void Initialize()
    {
        lock (_gate)
        {
            using var connection = OpenConnection();
            connection.Execute(@"
CREATE TABLE IF NOT EXISTS ServerNote(
    AccountId TEXT NOT NULL,
    Address TEXT NOT NULL,
    Text TEXT NOT NULL,
    UpdatedAtUtc TEXT NOT NULL,
    PRIMARY KEY(AccountId, Address)
);
CREATE INDEX IF NOT EXISTS IX_ServerNote_AccountId ON ServerNote(AccountId);
CREATE INDEX IF NOT EXISTS IX_ServerNote_UpdatedAtUtc ON ServerNote(UpdatedAtUtc);
", commandTimeout: 10);
        }
    }

    private SqliteConnection OpenConnection()
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = _databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
            Pooling = false
        }.ToString());
        connection.Open();
        connection.Execute("PRAGMA busy_timeout = 5000;");
        return connection;
    }

    private static ServerNote ToNote(ServerNoteRow row)
        => new(row.Address, row.Text, ParseTimestamp(row.UpdatedAtUtc));

    private static string FormatTimestamp(DateTimeOffset value)
        => value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private static DateTimeOffset ParseTimestamp(string value)
        => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToUniversalTime();

    private sealed record ServerNoteRow(string Address, string Text, string UpdatedAtUtc);
}

public sealed record ServerNote(string Address, string Text, DateTimeOffset UpdatedAtUtc);
