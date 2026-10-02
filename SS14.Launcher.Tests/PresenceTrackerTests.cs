#nullable enable

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using SS14.Launcher.Api;
using SS14.Launcher.Models;
using SS14.Launcher.Models.Presence;
using SS14.Launcher.Models.ServerStatus;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class PresenceTrackerTests
{
    [Test]
    public async Task StartsPollingOnlyAfterClientRunningAndReturnsToLauncherAfterExit()
    {
        var snapshots = new List<PresenceSnapshot>();
        var fetches = 0;
        var status = new ServerStatusSnapshot("Mados", 4, 20, null, null, ["map:Box", "mode:Roleplay"], 31, "en", "Box", "Roleplay");
        using var tracker = new PresenceTracker(
            (address, cancel) => { Interlocked.Increment(ref fetches); return Task.FromResult<ServerStatusSnapshot?>(status); },
            snapshot => snapshots.Add(snapshot),
            (_, _) => { },
            TimeSpan.FromMilliseconds(15));

        tracker.Configure(true, true, "Ende");
        tracker.Prepare("ss14://station.example:1212?token=secret", "Mados", "Ende", status);
        Assert.That(snapshots[^1].State, Is.EqualTo("connecting"));
        Assert.That(fetches, Is.Zero);

        tracker.ObserveStatus(Connector.ConnectionStatus.ClientRunning);
        Assert.That(snapshots[^1].State, Is.EqualTo("playing"));
        await Task.Delay(45);
        Assert.That(fetches, Is.GreaterThan(0));
        Assert.That(snapshots[^1].Address, Is.EqualTo("ss14://station.example:1212"));

        tracker.ObserveStatus(Connector.ConnectionStatus.ClientExited);
        Assert.That(snapshots[^1].State, Is.EqualTo("launcher"));
        var completedFetches = fetches;
        await Task.Delay(35);
        Assert.That(fetches, Is.EqualTo(completedFetches));
    }

    [Test]
    public void DoesNotCreatePresenceForContentBundles()
    {
        var snapshots = new List<PresenceSnapshot>();
        using var tracker = new PresenceTracker(
            (_, _) => Task.FromResult<ServerStatusSnapshot?>(null),
            snapshot => snapshots.Add(snapshot),
            (_, _) => { });

        tracker.Configure(true, true, "Ende");
        tracker.Prepare(null, null, null);
        tracker.ObserveStatus(Connector.ConnectionStatus.ClientRunning);

        Assert.That(snapshots[^1].State, Is.EqualTo("launcher"));
        Assert.That(snapshots[^1].ServerName, Is.Null);
    }
}
