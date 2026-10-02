using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace SS14.Launcher;

public sealed class MigrationException(string message) : Exception(message);

/// <summary>Copies only settings with SQLite's backup API; engine and content paths are adopted in place.</summary>
public static class DataMigration
{
    public sealed record Marker(int Version, string CreatedAt, string AppVersion, string? LegacyUser,
        string? LegacyLocal, string? Backup, string CacheUser, string CacheLocal);

    public static Marker Prepare(string? destination = null, string? legacyUser = null, string? legacyLocal = null)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var basePath = OperatingSystem.IsWindows() ? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData)
            : OperatingSystem.IsMacOS() ? Path.Combine(home, "Library", "Application Support")
            : Environment.GetEnvironmentVariable("XDG_DATA_HOME") ?? Path.Combine(home, ".local", "share");
        destination ??= Environment.GetEnvironmentVariable("MADOS_DATA_DIR") ?? Path.Combine(basePath, "Mados Launcher", "launcher");
        legacyUser ??= Path.Combine(basePath, "Space Station 14", "launcher");
        legacyLocal ??= OperatingSystem.IsWindows()
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Space Station 14", "launcher")
            : legacyUser;
        Directory.CreateDirectory(destination);
        var markerPath = Path.Combine(destination, "migration-v1.json");
        if (File.Exists(markerPath))
        {
            var existing = JsonSerializer.Deserialize<Marker>(File.ReadAllText(markerPath))
                ?? throw new MigrationException("Migration marker is unreadable. Restore it from the migration backup before retrying.");
            if (existing.Version != 1) throw new MigrationException("Unsupported migration marker version.");
            ApplyPaths(destination, existing);
            return existing;
        }

        var legacySettings = Path.Combine(legacyUser, "settings.db");
        // Some older installs placed all data in LOCALAPPDATA.
        if (!File.Exists(legacySettings) && File.Exists(Path.Combine(legacyLocal, "settings.db")))
            legacySettings = Path.Combine(legacyLocal, "settings.db");
        string? backup = null;
        var target = Path.Combine(destination, "settings.db");
        if (File.Exists(legacySettings))
        {
            StopLegacyProcess();
            backup = Path.Combine(destination, "backups", $"{DateTime.UtcNow:yyyyMMdd-HHmmss}-{LauncherVersion.Version}");
            Directory.CreateDirectory(backup);
            BackupDatabase(legacySettings, Path.Combine(backup, "settings.db"));
            if (!File.Exists(target))
            {
                var pending = target + ".migrating";
                File.Copy(Path.Combine(backup, "settings.db"), pending, overwrite: true);
                File.Move(pending, target);
            }
        }
        var marker = new Marker(1, DateTime.UtcNow.ToString("O"), LauncherVersion.Version?.ToString() ?? "unknown",
            Directory.Exists(legacyUser) ? legacyUser : null, Directory.Exists(legacyLocal) ? legacyLocal : null, backup,
            Directory.Exists(legacyUser) ? legacyUser : destination,
            Directory.Exists(legacyLocal) ? legacyLocal : Path.Combine(destination, "cache"));
        var tempMarker = markerPath + ".tmp";
        File.WriteAllText(tempMarker, JsonSerializer.Serialize(marker, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(tempMarker, markerPath, overwrite: true);
        ApplyPaths(destination, marker);
        return marker;
    }

    private static void ApplyPaths(string destination, Marker marker)
    {
        Environment.SetEnvironmentVariable("MADOS_DATA_DIR", destination);
        Environment.SetEnvironmentVariable("MADOS_CACHE_USER_DIR", marker.CacheUser);
        Environment.SetEnvironmentVariable("MADOS_CACHE_LOCAL_DIR", marker.CacheLocal);
    }

    private static void BackupDatabase(string source, string target)
    {
        using var from = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = source, Mode = SqliteOpenMode.ReadOnly }.ToString());
        using var to = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = target }.ToString());
        from.Open(); to.Open(); from.BackupDatabase(to);
        using var check = to.CreateCommand();
        check.CommandText = "PRAGMA integrity_check";
        if (!Equals(check.ExecuteScalar(), "ok")) throw new MigrationException("The settings backup failed its integrity check. Old data was preserved.");
    }

    private static void StopLegacyProcess()
    {
        foreach (var process in Process.GetProcessesByName("SS14.Launcher").Where(p => p.Id != Environment.ProcessId))
        {
            using (process)
            {
                if (process.CloseMainWindow() && process.WaitForExit(5000)) continue;
                throw new MigrationException("Close the running SS14 Launcher and retry. Migration has not modified the old data.");
            }
        }
    }
}
