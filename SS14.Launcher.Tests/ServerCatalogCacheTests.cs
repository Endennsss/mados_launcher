using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using SS14.Launcher.Models.ServerStatus;
using SS14.Launcher.Utility;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class ServerCatalogCacheTests
{
    private static readonly ServerCatalogHub[] Hubs = [Hub("hub.example")];
    private static ServerCatalogHub Hub(string host) => new(UrlFallbackSet.FromSingle(new Uri($"https://{host}/")), $"https://{host}/");
    private static TaskCompletionSource<T> Signal<T>() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static HttpResponseMessage Entries(string name = "Station", int count = 1) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(JsonSerializer.Serialize(Enumerable.Range(0, count).Select(i => new
        {
            address = $"ss14://station{i}.example",
            statusData = new { name, players = 12, soft_max_players = 80, tags = new[] { "lang:ru", "map:Box", "mode:Sandbox" } }
        })))
    };

    [Test]
    public async Task PublishesUsableCardsBeforePingFinishesAndCoalescesRepeatedLoads()
    {
        var releasePing = Signal<bool>();
        var available = Signal<ServerCatalogResult>();
        var requests = new ConcurrentBag<string>();
        using var client = new HttpClient(new Handler(async (request, cancel) =>
        {
            requests.Add(request.RequestUri.AbsolutePath);
            if (request.RequestUri.AbsolutePath == "/api/servers") return Entries();
            await releasePing.Task.WaitAsync(cancel);
            return new HttpResponseMessage(HttpStatusCode.OK);
        }));
        await using var cache = new ServerCatalogCache(client, update => { if (update.Servers.Length > 0) available.TrySetResult(update); });
        Assert.That(cache.Get(Hubs).Refreshing, Is.True);
        var early = await available.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Multiple(() =>
        {
            Assert.That(early.Servers.Single().PlayerCount, Is.EqualTo(12));
            Assert.That(early.Servers.Single().Map, Is.EqualTo("Box"));
            Assert.That(early.Servers.Single().PingMs, Is.Null);
            Assert.That(cache.Completion.IsCompleted, Is.False);
            Assert.That(cache.Get(Hubs).Servers, Has.Length.EqualTo(1));
            Assert.That(cache.Get(Hubs, true).Servers, Has.Length.EqualTo(1));
        });
        releasePing.SetResult(true);
        await cache.Completion;
        Assert.That(cache.Get(Hubs).Servers.Single().PingMs, Is.Not.Null);
        Assert.That(requests.Count(path => path == "/api/servers"), Is.EqualTo(1));
        Assert.That(requests.Count(path => path == "/status"), Is.EqualTo(1));
    }

    [Test]
    public async Task SlowHubDoesNotHideFastHubAndPriorityWinsRegardlessOfCompletionOrder()
    {
        var slowHub = Signal<bool>();
        var available = Signal<ServerCatalogResult>();
        using var client = new HttpClient(new Handler(async (request, cancel) =>
        {
            if (request.RequestUri.Host == "slow.example") { await slowHub.Task.WaitAsync(cancel); return Entries("Priority"); }
            return request.RequestUri.Host == "hub.example" ? Entries("Fast") : new HttpResponseMessage(HttpStatusCode.OK);
        }));
        await using var cache = new ServerCatalogCache(client, update => { if (update.Servers.Length > 0) available.TrySetResult(update); });
        ServerCatalogHub[] hubs = [Hub("slow.example"), ..Hubs];
        cache.Get(hubs);
        Assert.That((await available.Task.WaitAsync(TimeSpan.FromSeconds(2))).Servers.Single().Name, Is.EqualTo("Fast"));
        slowHub.SetResult(true);
        await cache.Completion;
        Assert.That(cache.Get(hubs).Servers.Single().Name, Is.EqualTo("Priority"));
    }

    [Test]
    public async Task RefreshBypassesWarmCacheAndFailurePreservesLastKnownList()
    {
        var fail = false;
        var name = "Before";
        using var client = new HttpClient(new Handler((request, _) => Task.FromResult(
            request.RequestUri.AbsolutePath != "/api/servers" ? new HttpResponseMessage(HttpStatusCode.OK)
            : fail ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) : Entries(name))));
        await using var cache = new ServerCatalogCache(client, _ => { });
        cache.Get(Hubs);
        await cache.Completion;
        name = "After";
        Assert.That(cache.Get(Hubs).Servers.Single().Name, Is.EqualTo("Before"));
        cache.Get(Hubs, true);
        await cache.Completion;
        Assert.That(cache.Get(Hubs).Servers.Single().Name, Is.EqualTo("After"));
        fail = true;
        cache.Get(Hubs, true);
        await cache.Completion;
        var failed = cache.Get(Hubs);
        Assert.Multiple(() =>
        {
            Assert.That(failed.Servers.Single().Name, Is.EqualTo("After"));
            Assert.That(failed.Stale, Is.True);
            Assert.That(failed.FailedHubs, Has.Length.EqualTo(1));
            Assert.That(failed.Refreshing, Is.False);
        });
    }

    [Test]
    public async Task ExpiredCacheRemainsVisibleWhileNewHubRequestRuns()
    {
        var clock = new Clock();
        var secondRequest = Signal<bool>();
        var block = false;
        using var client = new HttpClient(new Handler(async (request, cancel) =>
        {
            if (request.RequestUri.AbsolutePath != "/api/servers") return new HttpResponseMessage(HttpStatusCode.OK);
            if (block) await secondRequest.Task.WaitAsync(cancel);
            return Entries(block ? "New" : "Old");
        }));
        await using var cache = new ServerCatalogCache(client, _ => { }, clock);
        cache.Get(Hubs);
        await cache.Completion;
        block = true;
        clock.Now += TimeSpan.FromMinutes(1);
        var cached = cache.Get(Hubs);
        Assert.That(cached.Servers.Single().Name, Is.EqualTo("Old"));
        Assert.That(cached.Refreshing, Is.True);
        secondRequest.SetResult(true);
        await cache.Completion;
        Assert.That(cache.Get(Hubs).Servers.Single().Name, Is.EqualTo("New"));
    }

    [Test]
    public async Task BoundsParallelPingsAndKeepsUnknownPingSeparateFromHubAvailability()
    {
        var release = Signal<bool>();
        var firstWave = Signal<bool>();
        var active = 0;
        var peak = 0;
        var pingRequests = new ConcurrentBag<string>();
        using var client = new HttpClient(new Handler(async (request, cancel) =>
        {
            if (request.RequestUri.AbsolutePath == "/api/servers") return Entries(count: 40);
            pingRequests.Add(request.RequestUri.Host);
            var count = Interlocked.Increment(ref active);
            int observed;
            do { observed = peak; } while (count > observed && Interlocked.CompareExchange(ref peak, count, observed) != observed);
            if (count >= 12) firstWave.TrySetResult(true);
            try
            {
                await release.Task.WaitAsync(cancel);
                return new HttpResponseMessage(request.RequestUri.Host == "station1.example" ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK);
            }
            finally { Interlocked.Decrement(ref active); }
        }));
        await using var cache = new ServerCatalogCache(client, _ => { });
        cache.Get(Hubs);
        await firstWave.Task.WaitAsync(TimeSpan.FromSeconds(2));
        release.SetResult(true);
        var result = await cache.Completion;
        Assert.Multiple(() =>
        {
            Assert.That(peak, Is.LessThanOrEqualTo(12));
            Assert.That(pingRequests.Distinct().Count(), Is.EqualTo(40));
            Assert.That(result.Servers.Single(s => s.Address == "ss14://station0.example").PingMs, Is.Not.Null);
            var unreachablePing = result.Servers.Single(s => s.Address == "ss14://station1.example");
            Assert.That(unreachablePing.PingMs, Is.Null);
            Assert.That(unreachablePing.Status, Is.EqualTo("online"));
            Assert.That(result.Refreshing, Is.False);
        });
    }

    [Test]
    public async Task ShutdownCancelsOutstandingProbesAndDoesNotPublishAfterDisposal()
    {
        var probing = Signal<bool>();
        var cancelled = Signal<bool>();
        var events = new ConcurrentQueue<ServerCatalogResult>();
        using var client = new HttpClient(new Handler(async (request, cancel) =>
        {
            if (request.RequestUri.AbsolutePath == "/api/servers") return Entries(count: 40);
            probing.TrySetResult(true);
            try { await Task.Delay(Timeout.Infinite, cancel); }
            catch (OperationCanceledException) { cancelled.TrySetResult(true); throw; }
            return new HttpResponseMessage(HttpStatusCode.OK);
        }));
        var cache = new ServerCatalogCache(client, events.Enqueue);
        cache.Get(Hubs);
        await probing.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await cache.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2));
        Assert.That(cancelled.Task.IsCompletedSuccessfully, Is.True);
        Assert.That(cache.Completion.IsCompleted, Is.True);
        var revisions = events.Select(e => e.Revision).ToArray();
        Assert.That(revisions, Is.Ordered.Ascending);
        Assert.That(revisions.Distinct().Count(), Is.EqualTo(revisions.Length));
    }

    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel) => send(request, cancel);
    }

    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
