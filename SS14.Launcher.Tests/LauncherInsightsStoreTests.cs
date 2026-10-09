using System;
using System.IO;
using System.Linq;
using NUnit.Framework;
using SS14.Launcher.Worker;

#nullable enable

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class LauncherInsightsStoreTests
{
    private string _directory = null!;

    [SetUp]
    public void SetUp()
    {
        _directory = Path.Combine(Path.GetTempPath(), "mados-launcher-insights-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_directory);
    }

    [TearDown]
    public void TearDown()
    {
        if (Directory.Exists(_directory))
            Directory.Delete(_directory, recursive: true);
    }

    [Test]
    public void RecordsSamplesAndCalculatesDeltasPerServer()
    {
        var account = Guid.NewGuid();
        var store = NewStore();
        var first = DateTimeOffset.UtcNow.AddMinutes(-2);
        var second = first.AddMinutes(1);

        var initial = store.RecordSample(account, new MonitorSample("ss14://Station.Example:1212/?token=secret", "Station", true, 10, 50, 40, "Box", "Roleplay"), false, first);
        var latest = store.RecordSample(account, new MonitorSample("SS14://station.example", "Station", true, 14, 50, 47, "Box", "Roleplay"), false, second);

        Assert.That(initial.BecameOnline, Is.False);
        Assert.That(latest.Notification, Is.Null);
        var summary = store.GetFavoriteSummaries(account, new[] { new FavoriteMonitorTarget("ss14://station.example", "Station") }).Single();
        Assert.That(summary.PingMs, Is.EqualTo(47));
        Assert.That(summary.PingDeltaMs, Is.EqualTo(7));
        Assert.That(summary.PlayerDelta, Is.EqualTo(4));
        Assert.That(summary.Samples, Has.Count.EqualTo(2));
        Assert.That(summary.Address, Is.EqualTo("ss14://station.example"));
    }

    [Test]
    public void AvailabilityNotificationRequiresOfflineToOnlineTransition()
    {
        var account = Guid.NewGuid();
        var store = NewStore();
        var now = DateTimeOffset.UtcNow;

        var first = store.RecordSample(account, new MonitorSample("ss14://server.example", "Server", true, 1, 10, 20, null, null), true, now.AddMinutes(-3));
        var offline = store.RecordSample(account, new MonitorSample("ss14://server.example", "Server", false, null, null, null, null, null), true, now.AddMinutes(-2));
        var online = store.RecordSample(account, new MonitorSample("ss14://server.example", "Server", true, 2, 10, 21, null, null), true, now.AddMinutes(-1));

        Assert.That(first.Notification, Is.Null);
        Assert.That(offline.Notification, Is.Null);
        Assert.That(online.Notification?.Kind, Is.EqualTo("favorite-online"));
        Assert.That(store.ListNotifications(account), Has.Count.EqualTo(1));
    }

    [Test]
    public void SamplesAndProfilesAreIsolatedByAccount()
    {
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        var store = NewStore();
        store.RecordSample(first, new MonitorSample("ss14://shared.example", "First", true, 3, 20, 12, null, null), false);
        store.RecordSample(second, new MonitorSample("ss14://shared.example", "Second", true, 8, 20, 44, null, null), false);
        store.CreateProfile(first, "First profile", "ss14://shared.example");

        Assert.That(store.GetFavoriteSummaries(first, new[] { new FavoriteMonitorTarget("ss14://shared.example", null) }).Single().PlayerCount, Is.EqualTo(3));
        Assert.That(store.GetFavoriteSummaries(second, new[] { new FavoriteMonitorTarget("ss14://shared.example", null) }).Single().PlayerCount, Is.EqualTo(8));
        Assert.That(store.ListProfiles(first), Has.Count.EqualTo(1));
        Assert.That(store.ListProfiles(second), Is.Empty);
    }

    [Test]
    public void ProfilesSupportCreateUseUpdateAndRemove()
    {
        var account = Guid.NewGuid();
        var store = NewStore();
        var profile = store.CreateProfile(account, "  Main  ", "ss14://server.example:1212/");
        var duplicate = store.CreateProfile(account, "Renamed", "SS14://SERVER.EXAMPLE");
        var used = store.UseProfile(account, profile.Id);
        var updated = store.UpdateProfile(account, profile.Id, "Final", "ss14://new.example");

        Assert.That(duplicate.Id, Is.EqualTo(profile.Id));
        Assert.That(duplicate.Name, Is.EqualTo("Renamed"));
        Assert.That(used.LastUsedAtUtc, Is.Not.Null);
        Assert.That(updated.Name, Is.EqualTo("Final"));
        Assert.That(updated.Address, Is.EqualTo("ss14://new.example"));
        Assert.That(store.RemoveProfile(account, profile.Id), Is.True);
        Assert.That(store.ListProfiles(account), Is.Empty);
    }

    [Test]
    public void NotificationReadAndClearAreAccountScoped()
    {
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        var store = NewStore();
        var notification = store.AddNotification(first, "favorite-online", "Online", "Server");
        store.AddNotification(second, "favorite-online", "Other", "Server");

        Assert.That(store.MarkNotificationRead(first, notification.Id), Is.True);
        Assert.That(store.ListNotifications(first).Single().ReadAtUtc, Is.Not.Null);
        Assert.That(store.ClearNotifications(first), Is.EqualTo(1));
        Assert.That(store.ListNotifications(first), Is.Empty);
        Assert.That(store.ListNotifications(second), Has.Count.EqualTo(1));
    }

    [Test]
    public void OldSamplesAndNotificationsArePruned()
    {
        var account = Guid.NewGuid();
        var store = NewStore();
        var old = DateTimeOffset.UtcNow.AddDays(-LauncherInsightsStore.HistoryDays - 1);
        store.RecordSample(account, new MonitorSample("ss14://old.example", "Old", true, 1, 2, 3, null, null), false, old);
        store.RecordSample(account, new MonitorSample("ss14://new.example", "New", true, 2, 3, 4, null, null), false);
        Assert.That(store.GetFavoriteSummaries(account, new[] { new FavoriteMonitorTarget("ss14://old.example", null) }).Single().Samples, Is.Empty);

        for (var index = 0; index < LauncherInsightsStore.MaxNotifications + 5; index++)
            store.AddNotification(account, "game-update", "Title", $"Message {index}");
        Assert.That(store.ListNotifications(account), Has.Count.EqualTo(LauncherInsightsStore.MaxNotifications));
    }

    private LauncherInsightsStore NewStore() => new(Path.Combine(_directory, "launcher-insights.db"));
}
