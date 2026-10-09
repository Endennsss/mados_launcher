#nullable enable

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Dapper;
using Microsoft.Data.Sqlite;

namespace SS14.Launcher.Worker;

/// <summary>
/// Local metadata for imported, packaged SS14 server builds.  This database is
/// intentionally separate from settings.db and launcher-insights.db.
/// </summary>
public sealed class LocalServerStore
{
    private readonly string _databasePath;
    private readonly object _gate = new();

    public LocalServerStore(string? databasePath = null)
    {
        _databasePath = databasePath ?? Path.Combine(LauncherPaths.DirUserData, "launcher-tools.db");
        var directory = Path.GetDirectoryName(_databasePath);
        if (!string.IsNullOrWhiteSpace(directory))
            Directory.CreateDirectory(directory);
        Initialize();
    }

    public IReadOnlyList<LocalServerProfile> ListProfiles()
    {
        lock (_gate)
        {
            using var connection = OpenConnection();
            return connection.Query<LocalServerProfileRow>(@"
SELECT Id, Name, SourceUrl, InstallPath, Version, Platform, Architecture, Port,
       BindAddress, DataPath, ConfigPath, CreatedAtUtc, UpdatedAtUtc, LastStartedAtUtc
FROM LocalServerProfile ORDER BY COALESCE(LastStartedAtUtc, UpdatedAtUtc) DESC, Name COLLATE NOCASE ASC;")
                .Select(ToProfile).ToArray();
        }
    }

    public LocalServerProfile? Find(string id)
    {
        if (string.IsNullOrWhiteSpace(id))
            return null;
        lock (_gate)
        {
            using var connection = OpenConnection();
            var row = connection.QuerySingleOrDefault<LocalServerProfileRow>(@"
SELECT Id, Name, SourceUrl, InstallPath, Version, Platform, Architecture, Port,
       BindAddress, DataPath, ConfigPath, CreatedAtUtc, UpdatedAtUtc, LastStartedAtUtc
FROM LocalServerProfile WHERE Id = @Id;", new { Id = id });
            return row is null ? null : ToProfile(row);
        }
    }

    public LocalServerProfile Create(LocalServerProfile profile)
    {
        Validate(profile);
        lock (_gate)
        {
            using var connection = OpenConnection();
            connection.Execute(@"
INSERT INTO LocalServerProfile(Id, Name, SourceUrl, InstallPath, Version, Platform, Architecture, Port,
    BindAddress, DataPath, ConfigPath, CreatedAtUtc, UpdatedAtUtc, LastStartedAtUtc)
VALUES (@Id, @Name, @SourceUrl, @InstallPath, @Version, @Platform, @Architecture, @Port,
    @BindAddress, @DataPath, @ConfigPath, @CreatedAtUtc, @UpdatedAtUtc, @LastStartedAtUtc);", ToArgs(profile));
            return profile;
        }
    }

    public LocalServerProfile Update(LocalServerProfile profile)
    {
        Validate(profile);
        lock (_gate)
        {
            using var connection = OpenConnection();
            if (connection.Execute(@"
UPDATE LocalServerProfile SET Name=@Name, SourceUrl=@SourceUrl, InstallPath=@InstallPath,
Version=@Version, Platform=@Platform, Architecture=@Architecture, Port=@Port, BindAddress=@BindAddress,
DataPath=@DataPath, ConfigPath=@ConfigPath, UpdatedAtUtc=@UpdatedAtUtc, LastStartedAtUtc=@LastStartedAtUtc
WHERE Id=@Id;", ToArgs(profile)) == 0)
                throw new KeyNotFoundException("The local server profile was not found.");
            return profile;
        }
    }

    public bool Remove(string id)
    {
        lock (_gate)
        {
            using var connection = OpenConnection();
            return connection.Execute("DELETE FROM LocalServerProfile WHERE Id=@Id;", new { Id = id }) > 0;
        }
    }

    public LocalServerProfile MarkStarted(string id, DateTimeOffset startedAt)
    {
        var profile = Find(id) ?? throw new KeyNotFoundException("The local server profile was not found.");
        return Update(profile with { LastStartedAtUtc = startedAt.ToUniversalTime(), UpdatedAtUtc = DateTimeOffset.UtcNow });
    }

    public LocalServerBackup AddBackup(LocalServerBackup backup)
    {
        lock (_gate)
        {
            using var connection = OpenConnection();
            connection.Execute(@"
INSERT INTO LocalServerBackup(Id, ProfileId, ConfigPath, DataPath, CreatedAtUtc, Reason)
VALUES (@Id,@ProfileId,@ConfigPath,@DataPath,@CreatedAtUtc,@Reason);", new
            {
                backup.Id,
                backup.ProfileId,
                backup.ConfigPath,
                backup.DataPath,
                CreatedAtUtc = Format(backup.CreatedAtUtc),
                backup.Reason
            });
            return backup;
        }
    }

    public IReadOnlyList<LocalServerBackup> ListBackups(string profileId)
    {
        lock (_gate)
        {
            using var connection = OpenConnection();
            return connection.Query<LocalServerBackupRow>(@"SELECT Id, ProfileId, ConfigPath, DataPath, CreatedAtUtc, Reason FROM LocalServerBackup WHERE ProfileId=@ProfileId ORDER BY CreatedAtUtc DESC;", new { ProfileId = profileId })
                .Select(row => new LocalServerBackup(row.Id, row.ProfileId, row.ConfigPath, row.DataPath, Parse(row.CreatedAtUtc), row.Reason)).ToArray();
        }
    }

    public LocalServerBackup? FindBackup(string profileId, string backupId)
    {
        lock (_gate)
        {
            using var connection = OpenConnection();
            var row = connection.QuerySingleOrDefault<LocalServerBackupRow>(@"SELECT Id, ProfileId, ConfigPath, DataPath, CreatedAtUtc, Reason FROM LocalServerBackup WHERE ProfileId=@ProfileId AND Id=@Id;", new { ProfileId = profileId, Id = backupId });
            return row is null ? null : new LocalServerBackup(row.Id, row.ProfileId, row.ConfigPath, row.DataPath, Parse(row.CreatedAtUtc), row.Reason);
        }
    }

    private void Initialize()
    {
        lock (_gate)
        {
            using var connection = OpenConnection();
            connection.Execute(@"
CREATE TABLE IF NOT EXISTS LocalServerProfile(
    Id TEXT PRIMARY KEY,
    Name TEXT NOT NULL,
    SourceUrl TEXT NOT NULL,
    InstallPath TEXT NOT NULL,
    Version TEXT NOT NULL,
    Platform TEXT NOT NULL,
    Architecture TEXT NOT NULL,
    Port INTEGER NOT NULL,
    BindAddress TEXT NOT NULL,
    DataPath TEXT NOT NULL,
    ConfigPath TEXT NOT NULL,
    CreatedAtUtc TEXT NOT NULL,
    UpdatedAtUtc TEXT NOT NULL,
    LastStartedAtUtc TEXT
);
CREATE INDEX IF NOT EXISTS IX_LocalServerProfile_UpdatedAtUtc ON LocalServerProfile(UpdatedAtUtc);
CREATE TABLE IF NOT EXISTS LocalServerBackup(
    Id TEXT PRIMARY KEY,
    ProfileId TEXT NOT NULL,
    ConfigPath TEXT NOT NULL,
    DataPath TEXT NOT NULL,
    CreatedAtUtc TEXT NOT NULL,
    Reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS IX_LocalServerBackup_ProfileId ON LocalServerBackup(ProfileId);
CREATE INDEX IF NOT EXISTS IX_LocalServerBackup_CreatedAtUtc ON LocalServerBackup(CreatedAtUtc);
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
        connection.Execute("PRAGMA busy_timeout=5000;");
        return connection;
    }

    private static void Validate(LocalServerProfile profile)
    {
        if (string.IsNullOrWhiteSpace(profile.Id) || string.IsNullOrWhiteSpace(profile.Name))
            throw new ArgumentException("A local server profile needs an id and name.");
        if (profile.Port is < 1 or > 65535)
            throw new ArgumentOutOfRangeException(nameof(profile.Port));
        if (string.IsNullOrWhiteSpace(profile.InstallPath) || string.IsNullOrWhiteSpace(profile.ConfigPath)
            || string.IsNullOrWhiteSpace(profile.DataPath))
            throw new ArgumentException("A local server profile needs install, config and data paths.");
    }

    private static object ToArgs(LocalServerProfile profile) => new
    {
        profile.Id, profile.Name, profile.SourceUrl, profile.InstallPath, profile.Version,
        profile.Platform, profile.Architecture, profile.Port, profile.BindAddress, profile.DataPath,
        profile.ConfigPath,
        CreatedAtUtc = Format(profile.CreatedAtUtc),
        UpdatedAtUtc = Format(profile.UpdatedAtUtc),
        LastStartedAtUtc = profile.LastStartedAtUtc is { } value ? Format(value) : null
    };

    private static LocalServerProfile ToProfile(LocalServerProfileRow row) => new(
        row.Id, row.Name, row.SourceUrl, row.InstallPath, row.Version, row.Platform, row.Architecture,
        checked((int)row.Port), row.BindAddress, row.DataPath, row.ConfigPath, Parse(row.CreatedAtUtc),
        Parse(row.UpdatedAtUtc), ParseNullable(row.LastStartedAtUtc));

    private static string Format(DateTimeOffset value) => value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
    private static DateTimeOffset Parse(string value) => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToUniversalTime();
    private static DateTimeOffset? ParseNullable(string? value) => string.IsNullOrWhiteSpace(value) ? null : Parse(value);

    private sealed record LocalServerProfileRow(
        string Id, string Name, string SourceUrl, string InstallPath, string Version, string Platform,
        string Architecture, long Port, string BindAddress, string DataPath, string ConfigPath,
        string CreatedAtUtc, string UpdatedAtUtc, string? LastStartedAtUtc);
    private sealed record LocalServerBackupRow(string Id, string ProfileId, string ConfigPath, string DataPath, string CreatedAtUtc, string Reason);
}

public sealed record LocalServerProfile(
    string Id,
    string Name,
    string SourceUrl,
    string InstallPath,
    string Version,
    string Platform,
    string Architecture,
    int Port,
    string BindAddress,
    string DataPath,
    string ConfigPath,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    DateTimeOffset? LastStartedAtUtc);

public sealed record LocalServerBackup(
    string Id,
    string ProfileId,
    string ConfigPath,
    string DataPath,
    DateTimeOffset CreatedAtUtc,
    string Reason);
