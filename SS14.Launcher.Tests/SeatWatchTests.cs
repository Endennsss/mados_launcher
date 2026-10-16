using System;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using SS14.Launcher.Models.ServerStatus;
namespace SS14.Launcher.Tests;
[TestFixture] public sealed class SeatWatchTests
{
    [Test] public async Task WatchesOnlyAfterExplicitStartAndNotifiesOnce(){var calls=0;var alerts=0;var watch=new SeatWatch((_,_)=>{calls++;return Task.FromResult(new SeatProbe(5,10));},_=>{},_=>alerts++);await watch.PollAsync(CancellationToken.None);Assert.That(calls,Is.Zero);watch.Start("a","ss14://user:secret@localhost/?token=x","Station");await watch.PollAsync(CancellationToken.None);await watch.PollAsync(CancellationToken.None);Assert.That(alerts,Is.EqualTo(1));Assert.That(watch.Snapshot.Address,Does.Not.Contain("secret"));}
    [Test] public async Task LateResponseAfterCancellationCannotNotify(){var pending=new TaskCompletionSource<SeatProbe>();var alerts=0;var watch=new SeatWatch((_,_)=>pending.Task,_=>{},_=>alerts++);watch.Start("a","localhost","Station");var poll=watch.PollAsync(CancellationToken.None);watch.Stop();pending.SetResult(new SeatProbe(1,10));await poll;Assert.That(alerts,Is.Zero);Assert.That(watch.Snapshot.Status,Is.EqualTo("idle"));}
    [Test] public async Task MissingLimitIsUnknownAndTimeoutStopsPolling(){var now=DateTimeOffset.UtcNow;var calls=0;var watch=new SeatWatch((_,_)=>{calls++;return Task.FromResult(new SeatProbe(1,null));},_=>{},_=>Assert.Fail("No alert without limit"),()=>now);watch.Start("a","localhost","Station");await watch.PollAsync(CancellationToken.None);Assert.That(watch.Snapshot.Status,Is.EqualTo("unknown"));now=now.AddMinutes(31);await watch.PollAsync(CancellationToken.None);Assert.That(calls,Is.EqualTo(1));Assert.That(watch.Snapshot.Status,Is.EqualTo("expired"));}
}
