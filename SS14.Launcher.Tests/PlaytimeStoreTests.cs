using System;
using System.IO;
using Microsoft.Data.Sqlite;
using NUnit.Framework;
using SS14.Launcher.Models;
using SS14.Launcher.Models.Playtime;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class PlaytimeStoreTests
{
    private string _directory = null!;

    [SetUp]
    public void SetUp()
    {
        _directory = Path.Combine(Path.GetTempPath(), "mados-playtime-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_directory);
    }

    [TearDown]
    public void TearDown()
    {
        if (Directory.Exists(_directory))
            Directory.Delete(_directory, recursive: true);
    }

    [Test]
    public void CreatesDatabaseSchemaAndIndexes()
    {
        var path = Path.Combine(_directory, "schema.db");
        using var store = new TestStore(path);
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Pooling = false
        }.ToString());
        connection.Open();

        var tableSql = connection.CreateCommand();
        tableSql.CommandText = "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'PlaySession'";
        var table = tableSql.ExecuteScalar()?.ToString();
        Assert.That(table, Does.Contain("AccountId TEXT NOT NULL"));
        Assert.That(table, Does.Contain("LastSeenAtUtc TEXT NOT NULL"));

        var indexSql = connection.CreateCommand();
        indexSql.CommandText = "SELECT group_concat(name, ',') FROM sqlite_master WHERE type = 'index' AND tbl_name = 'PlaySession'";
        var indexes = indexSql.ExecuteScalar()?.ToString() ?? string.Empty;
        Assert.That(indexes, Does.Contain("IX_PlaySession_AccountId"));
        Assert.That(indexes, Does.Contain("IX_PlaySession_Address"));
        Assert.That(indexes, Does.Contain("IX_PlaySession_StartedAtUtc"));
    }

    [Test]
    public void GroupsSessionsByServerAndAccount()
    {
        var account = Guid.NewGuid();
        var otherAccount = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        using var store = new TestStore(_directory);

        var first = store.Value.StartSession(account, "ss14://alpha", "Alpha", now.AddMinutes(-65));
        store.Value.EndSession(first, now.AddMinutes(-35), "client_exited");
        var second = store.Value.StartSession(account, "ss14://alpha", "Alpha", now.AddMinutes(-25));
        store.Value.EndSession(second, now.AddMinutes(-5), "client_exited");
        var other = store.Value.StartSession(otherAccount, "ss14://alpha", "Other", now.AddMinutes(-10));
        store.Value.EndSession(other, now.AddMinutes(-1), "client_exited");

        var summary = store.Value.GetSummary(account, PlaytimePeriod.All, now);

        Assert.That(summary.TotalSeconds, Is.EqualTo(50 * 60));
        Assert.That(summary.SessionCount, Is.EqualTo(2));
        Assert.That(summary.UniqueServers, Is.EqualTo(1));
        Assert.That(summary.Servers[0].Name, Is.EqualTo("Alpha"));
        Assert.That(summary.Servers[0].SessionCount, Is.EqualTo(2));
        Assert.That(store.Value.GetSummary(otherAccount, PlaytimePeriod.All, now).TotalSeconds, Is.EqualTo(9 * 60));
    }

    [Test]
    public void ClipsSessionsToTodayAndSevenDayPeriods()
    {
        var account = Guid.NewGuid();
        var now = DateTimeOffset.Now;
        var todayStart = new DateTimeOffset(now.Date, now.Offset).ToUniversalTime();
        using var store = new TestStore(_directory);

        var today = store.Value.StartSession(account, "ss14://today", "Today", todayStart.AddMinutes(10));
        store.Value.EndSession(today, todayStart.AddMinutes(25), "client_exited");
        var old = store.Value.StartSession(account, "ss14://old", "Old", now.ToUniversalTime().AddDays(-8));
        store.Value.EndSession(old, now.ToUniversalTime().AddDays(-8).AddMinutes(20), "client_exited");

        var todaySummary = store.Value.GetSummary(account, PlaytimePeriod.Today, now.ToUniversalTime());
        var sevenDaySummary = store.Value.GetSummary(account, PlaytimePeriod.SevenDays, now.ToUniversalTime());

        Assert.That(todaySummary.TotalSeconds, Is.EqualTo(15 * 60));
        Assert.That(todaySummary.UniqueServers, Is.EqualTo(1));
        Assert.That(todaySummary.TrackedSince, Is.EqualTo(now.ToUniversalTime().AddDays(-8)));
        Assert.That(sevenDaySummary.TotalSeconds, Is.EqualTo(15 * 60));
        Assert.That(sevenDaySummary.Servers[0].Address, Is.EqualTo("ss14://today"));
    }

    [Test]
    public void RecoversOpenSessionAtLastHeartbeat()
    {
        var account = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        var path = Path.Combine(_directory, "playtime.db");
        using (var original = new TestStore(path))
        {
            var id = original.Value.StartSession(account, "ss14://recovery", "Recovery", now.AddMinutes(-10));
            original.Value.Heartbeat(id, now.AddMinutes(-3));
        }

        using var recovered = new TestStore(path);
        var summary = recovered.Value.GetSummary(account, PlaytimePeriod.All, now);

        Assert.That(summary.SessionCount, Is.EqualTo(1));
        Assert.That(summary.TotalSeconds, Is.EqualTo(7 * 60));
        Assert.That(summary.ActiveSession, Is.Null);
    }

    [Test]
    public void ClearRemovesCompletedRowsButKeepsActiveSession()
    {
        var account = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        using var store = new TestStore(_directory);
        var completed = store.Value.StartSession(account, "ss14://done", "Done", now.AddMinutes(-20));
        store.Value.EndSession(completed, now.AddMinutes(-10), "client_exited");
        var active = store.Value.StartSession(account, "ss14://active", "Active", now.AddMinutes(-5));

        Assert.That(store.Value.ClearCompleted(account), Is.EqualTo(1));
        var summary = store.Value.GetSummary(account, PlaytimePeriod.All, now);
        Assert.That(summary.SessionCount, Is.EqualTo(1));
        Assert.That(summary.ActiveSession?.Address, Is.EqualTo("ss14://active"));

        store.Value.EndSession(active, now, "client_exited");
        Assert.That(store.Value.ClearCompleted(account), Is.EqualTo(1));
        Assert.That(store.Value.GetSummary(account, PlaytimePeriod.All, now).SessionCount, Is.Zero);
    }

    [Test]
    public void TrackerStartsAndEndsOnlyForARealClientSession()
    {
        var account = Guid.NewGuid();
        var path = Path.Combine(_directory, "tracker.db");
        var updates = new System.Collections.Generic.List<PlaytimeUpdate>();
        using var store = new TestStore(path);
        using var tracker = new PlaytimeTracker(store.Value, updates.Add);

        tracker.Prepare(account, "ss14://tracker", "Tracker", countable: true);
        tracker.ObserveStatus(Connector.ConnectionStatus.StartingClient);
        Assert.That(store.Value.GetSummary(account, PlaytimePeriod.All, DateTimeOffset.UtcNow).SessionCount, Is.Zero);

        tracker.ObserveStatus(Connector.ConnectionStatus.ClientRunning);
        Assert.That(updates[^1].Active, Is.True);
        Assert.That(store.Value.GetSummary(account, PlaytimePeriod.All, DateTimeOffset.UtcNow).ActiveSession, Is.Not.Null);

        tracker.ObserveStatus(Connector.ConnectionStatus.ClientExited);
        var summary = store.Value.GetSummary(account, PlaytimePeriod.All, DateTimeOffset.UtcNow);
        Assert.That(summary.SessionCount, Is.EqualTo(1));
        Assert.That(summary.ActiveSession, Is.Null);
        Assert.That(updates[^1].Active, Is.False);
    }

    private sealed class TestStore : IDisposable
    {
        public TestStore(string directory)
        {
            var path = directory.EndsWith(".db", StringComparison.OrdinalIgnoreCase)
                ? directory
                : Path.Combine(directory, "playtime.db");
            Value = new PlaytimeStore(path);
        }

        public PlaytimeStore Value { get; }

        public void Dispose()
        {
            // PlaytimeStore opens short-lived SQLite connections for every
            // operation, so there is no long-lived handle to dispose here.
        }
    }
}
