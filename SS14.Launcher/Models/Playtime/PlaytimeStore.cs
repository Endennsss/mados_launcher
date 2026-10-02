using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Dapper;
using Microsoft.Data.Sqlite;

namespace SS14.Launcher.Models.Playtime;

/// <summary>
/// Local, account-scoped playtime persistence. This database deliberately lives
/// separately from settings.db so the statistics feature cannot affect legacy
/// launcher configuration or authentication data.
/// </summary>
public sealed class PlaytimeStore
{
    private readonly string _databasePath;
    private readonly object _gate = new();

    public PlaytimeStore(string? databasePath = null)
    {
        _databasePath = databasePath ?? Path.Combine(LauncherPaths.DirUserData, "playtime.db");
        var directory = Path.GetDirectoryName(_databasePath);
        if (!string.IsNullOrEmpty(directory))
            Directory.CreateDirectory(directory);

        Initialize();
        RecoverOpenSessions(DateTimeOffset.UtcNow);
    }

    public string StartSession(Guid accountId, string address, string? serverName, DateTimeOffset startedAt)
    {
        if (accountId == Guid.Empty)
            throw new ArgumentException("An account is required to track playtime.", nameof(accountId));
        if (string.IsNullOrWhiteSpace(address))
            throw new ArgumentException("A server address is required to track playtime.", nameof(address));

        var id = Guid.NewGuid().ToString("N");
        var timestamp = FormatTimestamp(startedAt);
        lock (_gate)
        {
            using var connection = OpenConnection();
            connection.Execute(
                "INSERT INTO PlaySession (Id, AccountId, Address, ServerName, StartedAtUtc, LastSeenAtUtc, EndedAtUtc, EndReason) VALUES (@Id, @AccountId, @Address, @ServerName, @StartedAtUtc, @LastSeenAtUtc, NULL, NULL)",
                new
                {
                    Id = id,
                    AccountId = accountId.ToString(),
                    Address = address,
                    ServerName = NormalizeName(serverName),
                    StartedAtUtc = timestamp,
                    LastSeenAtUtc = timestamp
                });
        }

        return id;
    }

    public void Heartbeat(string sessionId, DateTimeOffset timestamp)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
            return;

        lock (_gate)
        {
            using var connection = OpenConnection();
            connection.Execute(
                "UPDATE PlaySession SET LastSeenAtUtc = @LastSeenAtUtc WHERE Id = @Id AND EndedAtUtc IS NULL",
                new { Id = sessionId, LastSeenAtUtc = FormatTimestamp(timestamp) });
        }
    }

    public void EndSession(string sessionId, DateTimeOffset endedAt, string reason)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
            return;

        lock (_gate)
        {
            using var connection = OpenConnection();
            var timestamp = FormatTimestamp(endedAt);
            connection.Execute(
                "UPDATE PlaySession SET LastSeenAtUtc = @Timestamp, EndedAtUtc = @Timestamp, EndReason = @EndReason WHERE Id = @Id AND EndedAtUtc IS NULL",
                new { Id = sessionId, Timestamp = timestamp, EndReason = reason });
        }
    }

    public void RecoverOpenSessions(DateTimeOffset recoveredAt)
    {
        lock (_gate)
        {
            using var connection = OpenConnection();
            connection.Execute(@"
UPDATE PlaySession
SET EndedAtUtc = LastSeenAtUtc,
    EndReason = 'worker_restarted'
WHERE EndedAtUtc IS NULL;", commandTimeout: 10);
        }
    }

    public PlaytimeSummary GetSummary(Guid accountId, PlaytimePeriod period, DateTimeOffset now)
    {
        if (accountId == Guid.Empty)
            return PlaytimeSummary.Empty(null, period);

        var end = now.ToUniversalTime();
        var start = period switch
        {
            PlaytimePeriod.All => DateTimeOffset.MinValue,
            PlaytimePeriod.Today => StartOfLocalTodayUtc(end),
            PlaytimePeriod.SevenDays => end - TimeSpan.FromDays(7),
            _ => throw new ArgumentOutOfRangeException(nameof(period), period, null)
        };

        List<SessionRow> rows;
        lock (_gate)
        {
            using var connection = OpenConnection();
            rows = connection.Query<SessionRow>(
                "SELECT Id, AccountId, Address, ServerName, StartedAtUtc, LastSeenAtUtc, EndedAtUtc, EndReason FROM PlaySession WHERE AccountId = @AccountId ORDER BY StartedAtUtc DESC",
                new { AccountId = accountId.ToString() }).ToList();
        }

        var parsedRows = rows
            .Select(Parse)
            .ToArray();
        var sessions = parsedRows
            .Where(session => Overlaps(session.StartedAtUtc, session.EndedAtUtc ?? end, start, end))
            .ToArray();

        var summaries = sessions
            .GroupBy(session => session.Address, StringComparer.OrdinalIgnoreCase)
            .Select(group =>
            {
                var duration = group.Sum(session => DurationSeconds(session.StartedAtUtc, session.EndedAtUtc ?? end, start, end));
                var latest = group.MaxBy(session => session.EndedAtUtc ?? session.StartedAtUtc);
                var name = group.Select(session => session.ServerName).FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
                return new PlaytimeServerSummary(
                    group.Key,
                    name,
                    duration,
                    group.Count(),
                    latest?.EndedAtUtc ?? latest?.StartedAtUtc,
                    group.Any(session => session.EndedAtUtc is null));
            })
            .OrderByDescending(server => server.TotalSeconds)
            .ThenBy(server => server.Name ?? server.Address, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var active = parsedRows.FirstOrDefault(session => session.EndedAtUtc is null);
        DateTimeOffset? trackedSince = parsedRows.Length == 0 ? null : parsedRows.Min(session => session.StartedAtUtc);
        var totalSeconds = sessions.Sum(session => DurationSeconds(session.StartedAtUtc, session.EndedAtUtc ?? end, start, end));
        var activeDto = active is null
            ? null
            : new PlaytimeActiveSession(
                active.Address,
                active.ServerName,
                active.StartedAtUtc,
                Math.Max(0, (long)Math.Floor((end - active.StartedAtUtc).TotalSeconds)));

        return new PlaytimeSummary(
            accountId,
            period,
            trackedSince,
            totalSeconds,
            sessions.Length,
            summaries.Length,
            activeDto,
            summaries);
    }

    public int ClearCompleted(Guid accountId)
    {
        if (accountId == Guid.Empty)
            return 0;

        lock (_gate)
        {
            using var connection = OpenConnection();
            return connection.Execute(
                "DELETE FROM PlaySession WHERE AccountId = @AccountId AND EndedAtUtc IS NOT NULL",
                new { AccountId = accountId.ToString() });
        }
    }

    private void Initialize()
    {
        lock (_gate)
        {
            using var connection = OpenConnection();
            connection.Execute(@"
CREATE TABLE IF NOT EXISTS PlaySession(
    Id TEXT PRIMARY KEY NOT NULL,
    AccountId TEXT NOT NULL,
    Address TEXT NOT NULL,
    ServerName TEXT,
    StartedAtUtc TEXT NOT NULL,
    LastSeenAtUtc TEXT NOT NULL,
    EndedAtUtc TEXT,
    EndReason TEXT
);
CREATE INDEX IF NOT EXISTS IX_PlaySession_AccountId ON PlaySession(AccountId);
CREATE INDEX IF NOT EXISTS IX_PlaySession_Address ON PlaySession(Address);
CREATE INDEX IF NOT EXISTS IX_PlaySession_StartedAtUtc ON PlaySession(StartedAtUtc);
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

    private static DateTimeOffset StartOfLocalTodayUtc(DateTimeOffset nowUtc)
    {
        var local = nowUtc.ToLocalTime();
        return new DateTimeOffset(local.Date, local.Offset).ToUniversalTime();
    }

    private static bool Overlaps(DateTimeOffset start, DateTimeOffset end, DateTimeOffset rangeStart, DateTimeOffset rangeEnd)
        => start < rangeEnd && end > rangeStart;

    private static long DurationSeconds(DateTimeOffset start, DateTimeOffset end, DateTimeOffset rangeStart, DateTimeOffset rangeEnd)
    {
        var clippedStart = start > rangeStart ? start : rangeStart;
        var clippedEnd = end < rangeEnd ? end : rangeEnd;
        return clippedEnd <= clippedStart ? 0 : Math.Max(0, (long)Math.Floor((clippedEnd - clippedStart).TotalSeconds));
    }

    private static Session Parse(SessionRow row)
    {
        return new Session(
            row.Id,
            Guid.Parse(row.AccountId),
            row.Address,
            row.ServerName,
            ParseTimestamp(row.StartedAtUtc),
            ParseTimestamp(row.LastSeenAtUtc),
            row.EndedAtUtc == null ? null : ParseTimestamp(row.EndedAtUtc),
            row.EndReason);
    }

    private static string FormatTimestamp(DateTimeOffset value) => value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private static DateTimeOffset ParseTimestamp(string value) => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToUniversalTime();

    private static string? NormalizeName(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim()[..Math.Min(value.Trim().Length, 240)];

    private sealed record SessionRow(string Id, string AccountId, string Address, string? ServerName, string StartedAtUtc, string LastSeenAtUtc, string? EndedAtUtc, string? EndReason);

    private sealed record Session(string Id, Guid AccountId, string Address, string? ServerName, DateTimeOffset StartedAtUtc, DateTimeOffset LastSeenAtUtc, DateTimeOffset? EndedAtUtc, string? EndReason);
}

public enum PlaytimePeriod
{
    All,
    Today,
    SevenDays
}

public sealed record PlaytimeActiveSession(
    string Address,
    string? Name,
    DateTimeOffset StartedAt,
    long ElapsedSeconds);

public sealed record PlaytimeServerSummary(
    string Address,
    string? Name,
    long TotalSeconds,
    int SessionCount,
    DateTimeOffset? LastPlayedAt,
    bool Active);

public sealed record PlaytimeSummary(
    Guid? AccountId,
    PlaytimePeriod Period,
    DateTimeOffset? TrackedSince,
    long TotalSeconds,
    int SessionCount,
    int UniqueServers,
    PlaytimeActiveSession? ActiveSession,
    IReadOnlyList<PlaytimeServerSummary> Servers)
{
    public static PlaytimeSummary Empty(Guid? accountId, PlaytimePeriod period)
        => new(accountId, period, null, 0, 0, 0, null, Array.Empty<PlaytimeServerSummary>());
}
