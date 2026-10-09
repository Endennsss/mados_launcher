using System;
using System.IO;
using System.Linq;
using NUnit.Framework;
using SS14.Launcher.Models.RecentConnections;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class RecentConnectionStoreTests
{
    private string _directory = null!;

    [SetUp]
    public void SetUp()
    {
        _directory = Path.Combine(Path.GetTempPath(), "mados-recent-connection-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_directory);
    }

    [TearDown]
    public void TearDown()
    {
        if (Directory.Exists(_directory))
            Directory.Delete(_directory, recursive: true);
    }

    [Test]
    public void RecordsOnlyTheLatestConnectionPerAccountAndServer()
    {
        var account = Guid.NewGuid();
        var first = DateTimeOffset.UtcNow.AddMinutes(-10);
        using var store = new TestStore(Path.Combine(_directory, "recent.db"));

        store.Value.Record(account, "ss14://alpha.example:1212/?token=hidden", " Alpha ", first, 12, 35);
        store.Value.Record(account, "SS14://ALPHA.EXAMPLE:1212", "Alpha Prime", first.AddMinutes(5), 15, 29);

        var recent = store.Value.List(account, 10);

        Assert.That(recent, Has.Count.EqualTo(1));
        Assert.That(recent[0].Address, Is.EqualTo("ss14://alpha.example"));
        Assert.That(recent[0].Name, Is.EqualTo("Alpha Prime"));
        Assert.That(recent[0].PlayerCount, Is.EqualTo(15));
        Assert.That(recent[0].PingMs, Is.EqualTo(29));
        Assert.That(recent[0].LastConnectedAt, Is.EqualTo(first.AddMinutes(5)));
    }

    [Test]
    public void OrdersByNewestAndAppliesLimit()
    {
        var account = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        using var store = new TestStore(Path.Combine(_directory, "recent.db"));

        store.Value.Record(account, "ss14://old.example", "Old", now.AddMinutes(-30), 2, null);
        store.Value.Record(account, "ss14://new.example", "New", now.AddMinutes(-5), null, null);
        store.Value.Record(account, "ss14://middle.example", "Middle", now.AddMinutes(-15), 8, 55);

        var recent = store.Value.List(account, 2);

        Assert.That(recent.Select(item => item.Address), Is.EqualTo(new[] { "ss14://new.example", "ss14://middle.example" }));
        Assert.That(recent[0].PlayerCount, Is.Null);
        Assert.That(recent[0].PingMs, Is.Null);
    }

    [Test]
    public void KeepsRecentConnectionsIsolatedByAccount()
    {
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        using var store = new TestStore(Path.Combine(_directory, "recent.db"));

        store.Value.Record(first, "ss14://same.example", "First", DateTimeOffset.UtcNow, 1, 10);
        store.Value.Record(second, "ss14://same.example", "Second", DateTimeOffset.UtcNow.AddMinutes(1), 2, 20);

        Assert.That(store.Value.List(first).Single().Name, Is.EqualTo("First"));
        Assert.That(store.Value.List(second).Single().Name, Is.EqualTo("Second"));
    }

    [Test]
    public void RejectsEmptyAccountAddressAndInvalidLimit()
    {
        using var store = new TestStore(Path.Combine(_directory, "recent.db"));

        Assert.That(() => store.Value.List(Guid.Empty), Throws.TypeOf<ArgumentException>());
        Assert.That(() => store.Value.Record(Guid.Empty, "ss14://server.example", null, DateTimeOffset.UtcNow, null, null), Throws.TypeOf<ArgumentException>());
        Assert.That(() => store.Value.Record(Guid.NewGuid(), "https://server.example", null, DateTimeOffset.UtcNow, null, null), Throws.TypeOf<ArgumentException>());
        Assert.That(() => store.Value.List(Guid.NewGuid(), 0), Throws.TypeOf<ArgumentOutOfRangeException>());
    }

    private sealed class TestStore : IDisposable
    {
        public TestStore(string path) => Value = new RecentConnectionStore(path);

        public RecentConnectionStore Value { get; }

        public void Dispose()
        {
        }
    }
}
