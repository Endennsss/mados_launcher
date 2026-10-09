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
/// Local, account-scoped storage for optional launcher insights. It deliberately
/// lives outside settings.db so collecting history never changes existing user
/// data or authentication records.
/// </summary>
public sealed class LauncherInsightsStore
{
    public const int HistoryDays = 30;
    public const int MaxNotifications = 100;
    public const int MaxProfileNameLength = 120;
    private const int MaxAddressLength = 2_048;

    private readonly string _databasePath;
    private readonly object _gate = new();

    public LauncherInsightsStore(string? databasePath = null)
    {
        _databasePath = databasePath ?? Path.Combine(LauncherPaths.DirUserData, "launcher-insights.db");
        var directory = Path.GetDirectoryName(_databasePath);
        if (!string.IsNullOrEmpty(directory))
            Directory.CreateDirectory(directory);
        Initialize();
    }

    public MonitorSampleWriteResult RecordSample(Guid accountId, MonitorSample sample, bool createAvailabilityNotification, DateTimeOffset? capturedAt = null)
    {
        EnsureAccount(accountId);
        var normalized = NormalizeSample(sample, capturedAt ?? DateTimeOffset.UtcNow);

        lock (_gate)
        {
            using var connection = OpenConnection();
            var previous = connection.QuerySingleOrDefault<MonitorSampleRow>(@"
SELECT Address, ServerName, CapturedAtUtc, IsOnline, PlayerCount, SoftMaxPlayerCount, PingMs, Map, Mode
FROM ServerMonitorSample
WHERE AccountId = @AccountId AND Address = @Address
ORDER BY CapturedAtUtc DESC
LIMIT 1;", new { AccountId = accountId.ToString(), normalized.Address });

            connection.Execute(@"
INSERT INTO ServerMonitorSample(Id, AccountId, Address, ServerName, CapturedAtUtc, IsOnline, PlayerCount, SoftMaxPlayerCount, PingMs, Map, Mode)
VALUES (@Id, @AccountId, @Address, @ServerName, @CapturedAtUtc, @IsOnline, @PlayerCount, @SoftMaxPlayerCount, @PingMs, @Map, @Mode);", new
            {
                Id = Guid.NewGuid().ToString("N"),
                AccountId = accountId.ToString(),
                normalized.Address,
                normalized.ServerName,
                CapturedAtUtc = FormatTimestamp(normalized.CapturedAtUtc),
                IsOnline = normalized.IsOnline ? 1 : 0,
                normalized.PlayerCount,
                normalized.SoftMaxPlayerCount,
                normalized.PingMs,
                normalized.Map,
                normalized.Mode
            });

            var cutoff = normalized.CapturedAtUtc.AddDays(-HistoryDays);
            connection.Execute("DELETE FROM ServerMonitorSample WHERE CapturedAtUtc < @Cutoff;", new { Cutoff = FormatTimestamp(cutoff) });

            var becameOnline = previous is not null && previous.IsOnline == 0 && normalized.IsOnline;
            LauncherNotification? notification = null;
            if (createAvailabilityNotification && becameOnline)
            {
                var serverName = normalized.ServerName ?? normalized.Address;
                notification = AddNotificationLocked(connection, accountId, "favorite-online", "Сервер снова доступен", serverName, normalized.CapturedAtUtc);
            }
            return new MonitorSampleWriteResult(becameOnline, notification);
        }
    }

    public IReadOnlyList<FavoriteMonitorSummary> GetFavoriteSummaries(Guid accountId, IEnumerable<FavoriteMonitorTarget> favorites)
    {
        EnsureAccount(accountId);
        var targets = favorites
            .Select(target => new FavoriteMonitorTarget(NormalizeAddress(target.Address), NormalizeName(target.Name)))
            .GroupBy(target => target.Address, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .ToArray();

        lock (_gate)
        {
            using var connection = OpenConnection();
            return targets.Select(target => BuildSummary(connection, accountId, target)).ToArray();
        }
    }

    public IReadOnlyList<LaunchProfile> ListProfiles(Guid accountId)
    {
        EnsureAccount(accountId);
        lock (_gate)
        {
            using var connection = OpenConnection();
            return connection.Query<LaunchProfileRow>(@"
SELECT Id, Address, Name, CreatedAtUtc, LastUsedAtUtc
FROM LaunchProfile WHERE AccountId = @AccountId
ORDER BY CASE WHEN LastUsedAtUtc IS NULL THEN 1 ELSE 0 END, LastUsedAtUtc DESC, CreatedAtUtc DESC, Name COLLATE NOCASE ASC;", new { AccountId = accountId.ToString() })
                .Select(ToProfile)
                .ToArray();
        }
    }

    public LaunchProfile CreateProfile(Guid accountId, string name, string address)
    {
        EnsureAccount(accountId);
        var normalizedName = NormalizeProfileName(name);
        var normalizedAddress = NormalizeAddress(address);
        lock (_gate)
        {
            using var connection = OpenConnection();
            var existing = connection.QuerySingleOrDefault<LaunchProfileRow>(@"
SELECT Id, Address, Name, CreatedAtUtc, LastUsedAtUtc
FROM LaunchProfile WHERE AccountId = @AccountId AND Address = @Address;", new { AccountId = accountId.ToString(), Address = normalizedAddress });
            if (existing is not null)
            {
                connection.Execute("UPDATE LaunchProfile SET Name = @Name WHERE Id = @Id AND AccountId = @AccountId;", new { AccountId = accountId.ToString(), existing.Id, Name = normalizedName });
                return new LaunchProfile(existing.Id, normalizedAddress, normalizedName, ParseTimestamp(existing.CreatedAtUtc), ParseNullableTimestamp(existing.LastUsedAtUtc));
            }

            var created = DateTimeOffset.UtcNow;
            var profile = new LaunchProfile(Guid.NewGuid().ToString("N"), normalizedAddress, normalizedName, created, null);
            connection.Execute(@"
INSERT INTO LaunchProfile(Id, AccountId, Address, Name, CreatedAtUtc, LastUsedAtUtc)
VALUES (@Id, @AccountId, @Address, @Name, @CreatedAtUtc, NULL);", new
            {
                profile.Id,
                AccountId = accountId.ToString(),
                profile.Address,
                profile.Name,
                CreatedAtUtc = FormatTimestamp(profile.CreatedAtUtc)
            });
            return profile;
        }
    }

    public LaunchProfile UpdateProfile(Guid accountId, string id, string name, string address)
    {
        EnsureAccount(accountId);
        if (!Guid.TryParse(id, out _))
            throw new ArgumentException("The launch profile id is invalid.", nameof(id));
        var normalizedName = NormalizeProfileName(name);
        var normalizedAddress = NormalizeAddress(address);
        lock (_gate)
        {
            using var connection = OpenConnection();
            var existing = FindProfile(connection, accountId, id) ?? throw new KeyNotFoundException("The launch profile was not found.");
            var duplicate = connection.ExecuteScalar<long>("SELECT COUNT(*) FROM LaunchProfile WHERE AccountId = @AccountId AND Address = @Address AND Id <> @Id;", new { AccountId = accountId.ToString(), Address = normalizedAddress, Id = id });
            if (duplicate != 0)
                throw new ArgumentException("A launch profile already exists for this server.", nameof(address));
            connection.Execute(@"UPDATE LaunchProfile SET Name = @Name, Address = @Address WHERE AccountId = @AccountId AND Id = @Id;", new { AccountId = accountId.ToString(), Id = id, Name = normalizedName, Address = normalizedAddress });
            return new LaunchProfile(existing.Id, normalizedAddress, normalizedName, ParseTimestamp(existing.CreatedAtUtc), ParseNullableTimestamp(existing.LastUsedAtUtc));
        }
    }

    public bool RemoveProfile(Guid accountId, string id)
    {
        EnsureAccount(accountId);
        if (string.IsNullOrWhiteSpace(id))
            throw new ArgumentException("The launch profile id is required.", nameof(id));
        lock (_gate)
        {
            using var connection = OpenConnection();
            return connection.Execute("DELETE FROM LaunchProfile WHERE AccountId = @AccountId AND Id = @Id;", new { AccountId = accountId.ToString(), Id = id }) > 0;
        }
    }

    public LaunchProfile UseProfile(Guid accountId, string id)
    {
        EnsureAccount(accountId);
        if (string.IsNullOrWhiteSpace(id))
            throw new ArgumentException("The launch profile id is required.", nameof(id));
        lock (_gate)
        {
            using var connection = OpenConnection();
            var existing = FindProfile(connection, accountId, id) ?? throw new KeyNotFoundException("The launch profile was not found.");
            var usedAt = DateTimeOffset.UtcNow;
            connection.Execute("UPDATE LaunchProfile SET LastUsedAtUtc = @LastUsedAtUtc WHERE AccountId = @AccountId AND Id = @Id;", new { AccountId = accountId.ToString(), Id = id, LastUsedAtUtc = FormatTimestamp(usedAt) });
            return new LaunchProfile(existing.Id, existing.Address, existing.Name, ParseTimestamp(existing.CreatedAtUtc), usedAt);
        }
    }

    public LauncherNotification AddNotification(Guid? accountId, string kind, string title, string message, DateTimeOffset? createdAt = null)
    {
        if (accountId is { } id)
            EnsureAccount(id);
        if (string.IsNullOrWhiteSpace(kind) || string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(message))
            throw new ArgumentException("Notification kind, title and message are required.");
        var notification = new LauncherNotification(Guid.NewGuid().ToString("N"), kind.Trim(), TrimText(title, 240), TrimText(message, 1000), createdAt ?? DateTimeOffset.UtcNow, null);
        lock (_gate)
        {
            using var connection = OpenConnection();
            AddNotificationLocked(connection, accountId, notification.Kind, notification.Title, notification.Message, notification.CreatedAtUtc, notification.Id);
            return notification;
        }
    }

    public IReadOnlyList<LauncherNotification> ListNotifications(Guid accountId)
    {
        EnsureAccount(accountId);
        lock (_gate)
        {
            using var connection = OpenConnection();
            return connection.Query<NotificationRow>(@"
SELECT Id, AccountId, Kind, Title, Message, CreatedAtUtc, ReadAtUtc
FROM NotificationEvent WHERE AccountId = @AccountId OR AccountId IS NULL
ORDER BY CreatedAtUtc DESC LIMIT @Limit;", new { AccountId = accountId.ToString(), Limit = MaxNotifications })
                .Select(ToNotification)
                .ToArray();
        }
    }

    public bool MarkNotificationRead(Guid accountId, string id)
    {
        EnsureAccount(accountId);
        if (string.IsNullOrWhiteSpace(id))
            throw new ArgumentException("The notification id is required.", nameof(id));
        lock (_gate)
        {
            using var connection = OpenConnection();
            return connection.Execute("UPDATE NotificationEvent SET ReadAtUtc = @ReadAtUtc WHERE Id = @Id AND (AccountId = @AccountId OR AccountId IS NULL);", new { Id = id, AccountId = accountId.ToString(), ReadAtUtc = FormatTimestamp(DateTimeOffset.UtcNow) }) > 0;
        }
    }

    public int ClearNotifications(Guid accountId)
    {
        EnsureAccount(accountId);
        lock (_gate)
        {
            using var connection = OpenConnection();
            return connection.Execute("DELETE FROM NotificationEvent WHERE AccountId = @AccountId;", new { AccountId = accountId.ToString() });
        }
    }

    public static string NormalizeAddress(string address)
    {
        if (string.IsNullOrWhiteSpace(address))
            throw new ArgumentException("A server address is required.", nameof(address));
        var sanitized = PresenceAddress.Sanitize(address.Trim());
        if (sanitized is null || sanitized.Length > MaxAddressLength || !UriHelper.TryParseSs14Uri(sanitized, out var parsed))
            throw new ArgumentException("The server address is invalid.", nameof(address));
        var scheme = parsed.Scheme.ToLowerInvariant();
        var defaultPort = scheme == UriHelper.SchemeSs14 ? Global.DefaultServerPort : 443;
        try
        {
            var builder = new UriBuilder(parsed)
            {
                Scheme = scheme,
                Host = parsed.Host.ToLowerInvariant(),
                Port = parsed.Port == defaultPort ? -1 : parsed.Port,
                Path = parsed.AbsolutePath.TrimEnd('/'),
                Query = string.Empty,
                Fragment = string.Empty,
                UserName = string.Empty,
                Password = string.Empty
            };
            var normalized = builder.Uri.AbsoluteUri.TrimEnd('/');
            return normalized.Length <= MaxAddressLength ? normalized : throw new ArgumentException("The server address is invalid.", nameof(address));
        }
        catch (UriFormatException error)
        {
            throw new ArgumentException("The server address is invalid.", nameof(address), error);
        }
    }

    private FavoriteMonitorSummary BuildSummary(SqliteConnection connection, Guid accountId, FavoriteMonitorTarget target)
    {
        var rows = connection.Query<MonitorSampleRow>(@"
SELECT Address, ServerName, CapturedAtUtc, IsOnline, PlayerCount, SoftMaxPlayerCount, PingMs, Map, Mode
FROM ServerMonitorSample WHERE AccountId = @AccountId AND Address = @Address AND CapturedAtUtc >= @Cutoff
ORDER BY CapturedAtUtc ASC;", new { AccountId = accountId.ToString(), target.Address, Cutoff = FormatTimestamp(DateTimeOffset.UtcNow.AddDays(-HistoryDays)) }).ToArray();
        var latest = rows.LastOrDefault();
        var previous = rows.Length > 1 ? rows[^2] : null;
        return new FavoriteMonitorSummary(
            target.Address,
            latest?.ServerName ?? target.Name,
            latest?.IsOnline == 1,
            latest?.PlayerCount is { } latestPlayers ? checked((int) latestPlayers) : null,
            latest?.SoftMaxPlayerCount is { } latestSoftMax ? checked((int) latestSoftMax) : null,
            latest?.PingMs,
            latest?.PingMs is { } currentPing && previous?.PingMs is { } previousPing ? currentPing - previousPing : null,
            latest?.PlayerCount is { } currentPlayers && previous?.PlayerCount is { } previousPlayers ? checked((int) (currentPlayers - previousPlayers)) : null,
            rows.Select(row => new MonitorSamplePoint(ParseTimestamp(row.CapturedAtUtc), row.IsOnline == 1, row.PingMs, row.PlayerCount is { } players ? checked((int) players) : null)).ToArray());
    }

    private void Initialize()
    {
        lock (_gate)
        {
            using var connection = OpenConnection();
            connection.Execute(@"
CREATE TABLE IF NOT EXISTS ServerMonitorSample(
    Id TEXT PRIMARY KEY,
    AccountId TEXT NOT NULL,
    Address TEXT NOT NULL,
    ServerName TEXT,
    CapturedAtUtc TEXT NOT NULL,
    IsOnline INTEGER NOT NULL,
    PlayerCount INTEGER,
    SoftMaxPlayerCount INTEGER,
    PingMs INTEGER,
    Map TEXT,
    Mode TEXT
);
CREATE INDEX IF NOT EXISTS IX_ServerMonitorSample_AccountId ON ServerMonitorSample(AccountId);
CREATE INDEX IF NOT EXISTS IX_ServerMonitorSample_Address ON ServerMonitorSample(Address);
CREATE INDEX IF NOT EXISTS IX_ServerMonitorSample_CapturedAtUtc ON ServerMonitorSample(CapturedAtUtc);
CREATE TABLE IF NOT EXISTS LaunchProfile(
    Id TEXT PRIMARY KEY,
    AccountId TEXT NOT NULL,
    Address TEXT NOT NULL,
    Name TEXT NOT NULL,
    CreatedAtUtc TEXT NOT NULL,
    LastUsedAtUtc TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS UX_LaunchProfile_AccountAddress ON LaunchProfile(AccountId, Address);
CREATE INDEX IF NOT EXISTS IX_LaunchProfile_AccountId ON LaunchProfile(AccountId);
CREATE TABLE IF NOT EXISTS NotificationEvent(
    Id TEXT PRIMARY KEY,
    AccountId TEXT,
    Kind TEXT NOT NULL,
    Title TEXT NOT NULL,
    Message TEXT NOT NULL,
    CreatedAtUtc TEXT NOT NULL,
    ReadAtUtc TEXT
);
CREATE INDEX IF NOT EXISTS IX_NotificationEvent_AccountId ON NotificationEvent(AccountId);
CREATE INDEX IF NOT EXISTS IX_NotificationEvent_CreatedAtUtc ON NotificationEvent(CreatedAtUtc);
", commandTimeout: 10);
        }
    }

    private static MonitorSample NormalizeSample(MonitorSample sample, DateTimeOffset capturedAt)
        => sample with
        {
            Address = NormalizeAddress(sample.Address),
            ServerName = NormalizeName(sample.ServerName),
            CapturedAtUtc = capturedAt.ToUniversalTime(),
            PlayerCount = NormalizeNonNegative(sample.PlayerCount),
            SoftMaxPlayerCount = NormalizeNonNegative(sample.SoftMaxPlayerCount),
            PingMs = NormalizeNonNegative(sample.PingMs),
            Map = NormalizeName(sample.Map),
            Mode = NormalizeName(sample.Mode)
        };

    private static int? NormalizeNonNegative(int? value) => value is >= 0 ? value : null;
    private static long? NormalizeNonNegative(long? value) => value is >= 0 ? value : null;
    private static string? NormalizeName(string? value) => string.IsNullOrWhiteSpace(value) ? null : TrimText(value.Trim(), 240);
    private static string NormalizeProfileName(string value) => string.IsNullOrWhiteSpace(value) ? throw new ArgumentException("A profile name is required.", nameof(value)) : TrimText(value.Trim(), MaxProfileNameLength);
    private static string TrimText(string value, int max) => value.Length <= max ? value : value[..max];
    private static void EnsureAccount(Guid accountId) { if (accountId == Guid.Empty) throw new ArgumentException("An account is required.", nameof(accountId)); }

    private static LaunchProfileRow? FindProfile(SqliteConnection connection, Guid accountId, string id)
        => connection.QuerySingleOrDefault<LaunchProfileRow>("SELECT Id, Address, Name, CreatedAtUtc, LastUsedAtUtc FROM LaunchProfile WHERE AccountId = @AccountId AND Id = @Id;", new { AccountId = accountId.ToString(), Id = id });

    private static LauncherNotification AddNotificationLocked(SqliteConnection connection, Guid? accountId, string kind, string title, string message, DateTimeOffset createdAt, string? id = null)
    {
        var notification = new LauncherNotification(id ?? Guid.NewGuid().ToString("N"), kind, title, message, createdAt.ToUniversalTime(), null);
        connection.Execute(@"INSERT INTO NotificationEvent(Id, AccountId, Kind, Title, Message, CreatedAtUtc, ReadAtUtc) VALUES (@Id, @AccountId, @Kind, @Title, @Message, @CreatedAtUtc, NULL);", new { Id = notification.Id, AccountId = accountId?.ToString(), Kind = notification.Kind, Title = notification.Title, Message = notification.Message, CreatedAtUtc = FormatTimestamp(notification.CreatedAtUtc) });
        var cutoff = createdAt.ToUniversalTime().AddDays(-HistoryDays);
        connection.Execute("DELETE FROM NotificationEvent WHERE CreatedAtUtc < @Cutoff;", new { Cutoff = FormatTimestamp(cutoff) });
        var accountKey = accountId?.ToString();
        var ids = connection.Query<string>("SELECT Id FROM NotificationEvent WHERE (AccountId = @AccountId OR (AccountId IS NULL AND @AccountId IS NULL)) ORDER BY CreatedAtUtc DESC LIMIT -1 OFFSET @Limit;", new { AccountId = accountKey, Limit = MaxNotifications }).ToArray();
        if (ids.Length > 0)
            connection.Execute("DELETE FROM NotificationEvent WHERE Id IN @Ids;", new { Ids = ids });
        return notification;
    }

    private SqliteConnection OpenConnection()
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = _databasePath, Mode = SqliteOpenMode.ReadWriteCreate, Cache = SqliteCacheMode.Shared, Pooling = false }.ToString());
        connection.Open();
        connection.Execute("PRAGMA busy_timeout = 5000;");
        return connection;
    }

    private static LaunchProfile ToProfile(LaunchProfileRow row) => new(row.Id, row.Address, row.Name, ParseTimestamp(row.CreatedAtUtc), ParseNullableTimestamp(row.LastUsedAtUtc));
    private static LauncherNotification ToNotification(NotificationRow row) => new(row.Id, row.Kind, row.Title, row.Message, ParseTimestamp(row.CreatedAtUtc), ParseNullableTimestamp(row.ReadAtUtc));
    private static DateTimeOffset ParseTimestamp(string value) => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToUniversalTime();
    private static DateTimeOffset? ParseNullableTimestamp(string? value) => string.IsNullOrWhiteSpace(value) ? null : ParseTimestamp(value);
    private static string FormatTimestamp(DateTimeOffset value) => value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private sealed record MonitorSampleRow(string Address, string? ServerName, string CapturedAtUtc, long IsOnline, long? PlayerCount, long? SoftMaxPlayerCount, long? PingMs, string? Map, string? Mode);
    private sealed record LaunchProfileRow(string Id, string Address, string Name, string CreatedAtUtc, string? LastUsedAtUtc);
    private sealed record NotificationRow(string Id, string? AccountId, string Kind, string Title, string Message, string CreatedAtUtc, string? ReadAtUtc);
}

public sealed record MonitorSample(string Address, string? ServerName, bool IsOnline, int? PlayerCount, int? SoftMaxPlayerCount, long? PingMs, string? Map, string? Mode, DateTimeOffset CapturedAtUtc = default);
public sealed record MonitorSampleWriteResult(bool BecameOnline, LauncherNotification? Notification);
public sealed record FavoriteMonitorTarget(string Address, string? Name);
public sealed record MonitorSamplePoint(DateTimeOffset CapturedAt, bool IsOnline, long? PingMs, int? PlayerCount);
public sealed record FavoriteMonitorSummary(string Address, string? Name, bool IsOnline, int? PlayerCount, int? SoftMaxPlayerCount, long? PingMs, long? PingDeltaMs, int? PlayerDelta, IReadOnlyList<MonitorSamplePoint> Samples);
public sealed record LaunchProfile(string Id, string Address, string Name, DateTimeOffset CreatedAtUtc, DateTimeOffset? LastUsedAtUtc);
public sealed record LauncherNotification(string Id, string Kind, string Title, string Message, DateTimeOffset CreatedAtUtc, DateTimeOffset? ReadAtUtc);
