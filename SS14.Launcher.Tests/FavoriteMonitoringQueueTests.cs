using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using SS14.Launcher.Worker;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class FavoriteMonitoringQueueTests
{
    [Test]
    public async Task NewRefreshCannotOverwriteSamplesWhileOlderRefreshStillWaitsForHub()
    {
        var queue = new FavoriteMonitoringQueue();
        var hub = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var writes = new List<int>();
        var first = queue.RunAsync(async () => { await hub.Task; writes.Add(1); return 1; }, CancellationToken.None);
        var second = queue.RunAsync(() => { writes.Add(2); return Task.FromResult(2); }, CancellationToken.None);
        Assert.That(writes, Is.Empty);
        hub.SetResult(true);
        await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(2));
        Assert.That(writes, Is.EqualTo(new[] { 1, 2 }));
    }

    [Test]
    public async Task FailureDoesNotPreventNextManualRefresh()
    {
        var queue = new FavoriteMonitoringQueue();
        Assert.ThrowsAsync<InvalidOperationException>(() => queue.RunAsync<int>(() => throw new InvalidOperationException(), CancellationToken.None));
        Assert.That(await queue.RunAsync(() => Task.FromResult(42), CancellationToken.None), Is.EqualTo(42));
    }

    [Test]
    public async Task ShutdownCancelsQueuedProbeWithoutRunningIt()
    {
        var queue = new FavoriteMonitoringQueue();
        var release = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = queue.RunAsync(() => release.Task, CancellationToken.None);
        using var cancel = new CancellationTokenSource();
        var called = false;
        var second = queue.RunAsync(() => { called = true; return Task.FromResult(1); }, cancel.Token);
        cancel.Cancel();
        Assert.CatchAsync<OperationCanceledException>(async () => await second);
        Assert.That(called, Is.False);
        release.SetResult(0);
        await first;
    }
}
