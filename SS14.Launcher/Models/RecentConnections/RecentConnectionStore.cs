using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Dapper;
using Microsoft.Data.Sqlite;
using SS14.Launcher.Models.ServerStatus;

namespace SS14.Launcher.Models.RecentConnections;

/// <summary>
/// Stores the last successful connection to each server for each account.
/// This database is intentionally separate from settings and playtime data.
/// </summary>
public sealed class RecentConnectionStore : IDisposable
{
    public const int DefaultLimit = 8;
    public const int MaxLimit = 50;

    private readonly string _databasePath;
    private readonly object _gate = new();

    public RecentConnectionStore(string? databasePath = null)
    {
        _databasePath = databasePath ?? Path.Combine(LauncherPaths.DirUserData, "recent-connections.db");
        var directory = Path.GetDirectoryName(_databasePath);
        if (!string.IsNullOrEmpty(directory))
            Directory.CreateDirectory(directory);

        Initialize();
    }

    public void Record(
        Guid accountId,
        string address,
        string? name,
        DateTimeOffset lastConnectedAt,
        int? playerCount,
        long? pingMs)
    {
        EnsureAccount(accountId);
        var normalizedAddress = NormalizeAddress(address);
        var normalizedName = NormalizeName(name);
        var timestamp = FormatTimestamp(lastConnectedAt);
        var normalizedPlayers = NormalizePlayerCount(playerCount);
        var normalizedPing = NormalizePing(pingMs);

        lock (_gate)
        {
            using var connection = OpenConnection();
            connection.Execute(@"
INSERT INTO RecentConnection(AccountId, Address, Name, LastConnectedAtUtc, PlayerCount, PingMs)
VALUES (@AccountId, @Address, @Name, @LastConnectedAtUtc, @PlayerCount, @PingMs)
ON CONFLICT(AccountId, Address) DO UPDATE SET
    Name = excluded.Name,
    LastConnectedAtUtc = excluded.LastConnectedAtUtc,
    PlayerCount = excluded.PlayerCount,
    PingMs = excluded.PingMs;",
                new
                {
                    AccountId = accountId.ToString(),
                    Address = normalizedAddress,
                    Name = normalizedName,
                    LastConnectedAtUtc = timestamp,
                    PlayerCount = normalizedPlayers,
                    PingMs = normalizedPing
                });
        }
    }

    public IReadOnlyList<RecentConnection> List(Guid accountId, int limit = DefaultLimit)
    {
        EnsureAccount(accountId);
        if (limit is < 1 or > MaxLimit)
            throw new ArgumentOutOfRangeException(nameof(limit), $"Recent connection limit must be between 1 and {MaxLimit}.");

        lock (_gate)
        {
            using var connection = OpenConnection();
            return connection.Query<RecentConnectionRow>(@"
SELECT Address, Name, LastConnectedAtUtc, PlayerCount, PingMs
FROM RecentConnection
WHERE AccountId = @AccountId
ORDER BY LastConnectedAtUtc DESC, Address COLLATE NOCASE ASC
LIMIT @Limit;",
                    new { AccountId = accountId.ToString(), Limit = limit })
                .Select(ToRecentConnection)
                .ToArray();
        }
    }

    private void Initialize()
    {
        lock (_gate)
        {
            using var connection = OpenConnection();
            connection.Execute(@"
CREATE TABLE IF NOT EXISTS RecentConnection(
    AccountId TEXT NOT NULL,
    Address TEXT NOT NULL,
    Name TEXT,
    LastConnectedAtUtc TEXT NOT NULL,
    PlayerCount INTEGER,
    PingMs INTEGER,
    PRIMARY KEY(AccountId, Address)
);
CREATE INDEX IF NOT EXISTS IX_RecentConnection_AccountId ON RecentConnection(AccountId);
CREATE INDEX IF NOT EXISTS IX_RecentConnection_LastConnectedAtUtc ON RecentConnection(LastConnectedAtUtc);
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

    private static RecentConnection ToRecentConnection(RecentConnectionRow row)
        => new(
            row.Address,
            row.Name,
            ParseTimestamp(row.LastConnectedAtUtc),
            row.PlayerCount is { } players ? checked((int)players) : null,
            row.PingMs);

    private static string NormalizeAddress(string address)
    {
        var sanitized = PresenceAddress.Sanitize(address);
        if (sanitized is null || !UriHelper.TryParseSs14Uri(sanitized, out var parsed))
            throw new ArgumentException("The server address is invalid.", nameof(address));

        var defaultPort = parsed.Scheme == UriHelper.SchemeSs14 ? Global.DefaultServerPort : 443;
        var builder = new UriBuilder(parsed)
        {
            Port = parsed.Port == defaultPort ? -1 : parsed.Port,
            Path = parsed.AbsolutePath.TrimEnd('/'),
            Query = string.Empty,
            Fragment = string.Empty,
            UserName = string.Empty,
            Password = string.Empty
        };
        return builder.Uri.AbsoluteUri.TrimEnd('/');
    }

    private static string? NormalizeName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
            return null;

        var value = name.Trim();
        return value[..Math.Min(value.Length, 240)];
    }

    private static int? NormalizePlayerCount(int? value)
        => value is >= 0 ? value : null;

    private static long? NormalizePing(long? value)
        => value is >= 0 ? value : null;

    private static void EnsureAccount(Guid accountId)
    {
        if (accountId == Guid.Empty)
            throw new ArgumentException("An account is required for recent connections.", nameof(accountId));
    }

    private static string FormatTimestamp(DateTimeOffset value)
        => value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private static DateTimeOffset ParseTimestamp(string value)
        => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToUniversalTime();

    private sealed record RecentConnectionRow(
        string Address,
        string? Name,
        string LastConnectedAtUtc,
        long? PlayerCount,
        long? PingMs);

    public void Dispose()
    {
        // Connections are intentionally short-lived; there is no handle to close.
    }
}

public sealed record RecentConnection(
    string Address,
    string? Name,
    DateTimeOffset LastConnectedAt,
    int? PlayerCount,
    long? PingMs);
