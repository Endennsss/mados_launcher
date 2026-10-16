#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using SS14.Launcher.Models.Maintenance;

namespace SS14.Launcher.Tests;
[TestFixture]
public sealed class CacheTransferTests
{
    private string _root=null!,_user=null!,_local=null!,_marker=null!;
    [SetUp] public void Setup(){_root=Path.Combine(Path.GetTempPath(),"mados-transfer",Guid.NewGuid().ToString("N"));_user=Path.Combine(_root,"user");_local=Path.Combine(_root,"local");Directory.CreateDirectory(Path.Combine(_user,"engines"));Directory.CreateDirectory(_local);_marker=Path.Combine(_root,"migration-v1.json");File.WriteAllText(_marker,JsonSerializer.Serialize(new{Version=1,CacheUser=_user,CacheLocal=_local}));File.WriteAllText(Path.Combine(_user,"engines","1.zip"),"engine");File.WriteAllText(Path.Combine(_local,"content.db"),"content");File.WriteAllText(Path.Combine(_user,"settings.db"),"secret");}
    [TearDown] public void Cleanup(){Directory.Delete(_root,true);}
    [Test] public async Task CopiesVerifiesAndSwitchesOnlyManagedCacheAfterSuccess(){var mover=new CacheTransfer(_marker);var progress=0;var result=await mover.MoveAsync(Path.Combine(_root,"destination"),_=>progress++,CancellationToken.None);Assert.That(progress,Is.GreaterThan(0));Assert.That(result.Stage,Is.EqualTo("ready"));using var marker=JsonDocument.Parse(File.ReadAllText(_marker));var target=marker.RootElement.GetProperty("CacheLocal").GetString()!;Assert.That(File.ReadAllText(Path.Combine(target,"content.db")),Is.EqualTo("content"));Assert.That(File.Exists(Path.Combine(_local,"content.db")),Is.True);Assert.That(Directory.GetFiles(result.Destination!,"settings.db",SearchOption.AllDirectories),Is.Empty);Assert.That(mover.CleanupPrevious(()=>false),Is.Empty);Assert.That(File.Exists(Path.Combine(_local,"content.db")),Is.False);Assert.That(File.Exists(Path.Combine(_user,"settings.db")),Is.True);}
    [Test] public async Task CancellationPreservesMarkerAndSource(){var before=File.ReadAllText(_marker);using var cancel=new CancellationTokenSource();cancel.Cancel();Assert.ThrowsAsync<OperationCanceledException>(async()=>await new CacheTransfer(_marker).MoveAsync(Path.Combine(_root,"target"),_=>{},cancel.Token));Assert.That(File.ReadAllText(_marker),Is.EqualTo(before));Assert.That(File.Exists(Path.Combine(_local,"content.db")),Is.True);await Task.CompletedTask;}
    [Test] public void RefusesNestedDestination(){Assert.ThrowsAsync<InvalidOperationException>(async()=>await new CacheTransfer(_marker).MoveAsync(Path.Combine(_user,"engines","nested"),_=>{},CancellationToken.None));}
    [Test] public async Task CleanupKeepsChangedOriginalAndActiveClientFiles(){var mover=new CacheTransfer(_marker);await mover.MoveAsync(Path.Combine(_root,"target"),_=>{},CancellationToken.None);Assert.That(mover.CleanupPrevious(()=>true),Is.Not.Empty);Assert.That(File.Exists(Path.Combine(_local,"content.db")),Is.True);File.WriteAllText(Path.Combine(_local,"content.db"),"changed");Assert.That(mover.CleanupPrevious(()=>false),Is.Not.Empty);Assert.That(File.ReadAllText(Path.Combine(_local,"content.db")),Is.EqualTo("changed"));}
    [Test] public async Task ChangedDestinationAfterDeferredCleanupPreservesOriginalAndAllowsAnotherMove(){var mover=new CacheTransfer(_marker);var first=await mover.MoveAsync(Path.Combine(_root,"target"),_=>{},CancellationToken.None);mover.CleanupPrevious(()=>true);File.WriteAllText(Path.Combine(first.Destination!,"content.db"),"new downloaded content");Assert.That(mover.CleanupPrevious(()=>false),Is.Not.Empty);Assert.That(File.ReadAllText(Path.Combine(_local,"content.db")),Is.EqualTo("content"));var next=await mover.MoveAsync(Path.Combine(_root,"second"),_=>{},CancellationToken.None);Assert.That(next.Stage,Is.EqualTo("ready"));}
}
