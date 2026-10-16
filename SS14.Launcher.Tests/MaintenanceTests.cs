#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Dapper;
using Microsoft.Data.Sqlite;
using NUnit.Framework;
using SS14.Launcher.Models.Maintenance;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class MaintenanceTests
{
    private string _root = null!;
    private bool _busy;
    private DateTimeOffset _now;
    private ManagedStorage _storage = null!;
    private SqliteConnection Open() { var c=new SqliteConnection($"Data Source={Path.Combine(_root,"content.db")};Pooling=False;Foreign Keys=True");c.Open();return c; }
    [SetUp] public void Setup()
    {
        _root=Path.Combine(Path.GetTempPath(),"mados-maintenance-tests",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(_root);_busy=false;_now=DateTimeOffset.UtcNow;
        using var c=Open();c.Execute(@"
CREATE TABLE ContentVersion(Id INTEGER PRIMARY KEY, ForkId TEXT, ForkVersion TEXT, LastUsed TEXT);
CREATE TABLE Content(Id INTEGER PRIMARY KEY, Data BLOB);
CREATE TABLE ContentManifest(VersionId INTEGER REFERENCES ContentVersion(Id) ON DELETE CASCADE, ContentId INTEGER REFERENCES Content(Id));
CREATE TABLE ContentEngineDependency(VersionId INTEGER REFERENCES ContentVersion(Id) ON DELETE CASCADE, ModuleName TEXT, ModuleVersion TEXT);
CREATE TABLE InterruptedDownloadContent(ContentId INTEGER);
CREATE TABLE RunningClient(ProcessId INTEGER PRIMARY KEY, MainModule TEXT, UsedVersion INTEGER REFERENCES ContentVersion(Id));
INSERT INTO ContentVersion VALUES(1,'station','old','2024-01-01'),(2,'station','current','2026-01-01');
INSERT INTO Content VALUES(1,zeroblob(100)),(2,zeroblob(200)),(3,zeroblob(300)),(4,zeroblob(400));
INSERT INTO ContentManifest VALUES(1,1),(1,2),(1,4),(2,2),(2,3);
INSERT INTO InterruptedDownloadContent VALUES(4);");
        _storage=new ManagedStorage(Path.Combine(_root,"content.db"),Path.Combine(_root,"engines"),Path.Combine(_root,"modules"),Path.Combine(_root,"logs"),Path.Combine(_root,"local-servers"),()=>_busy,()=>_now);
    }
    [TearDown] public void Cleanup(){if(Directory.Exists(_root))Directory.Delete(_root,true);}
    [Test] public void ProtectsNewestAndOnlyCountsExclusiveUninterruptedBlobs()
    {
        var scan=_storage.Scan();Assert.That(scan.Items.Single(i=>i.Id=="content:2").CanDelete,Is.False);
        var plan=_storage.Preview(new[]{"content:1"});Assert.That(plan.EstimatedBytes,Is.EqualTo(100));
        var result=_storage.Clean(plan.PlanId);Assert.That(result.RemovedItems,Is.EqualTo(1));
        using var c=Open();Assert.That(c.Query<long>("SELECT Id FROM Content ORDER BY Id"),Is.EqualTo(new long[]{2,3,4}));
        Assert.That(c.ExecuteScalar<long>("SELECT COUNT(*) FROM ContentVersion"),Is.EqualTo(1));
    }
    [Test] public void RejectsLatestArbitraryAndExpiredSelections()
    {
        Assert.Throws<InvalidOperationException>(()=>_storage.Preview(new[]{"content:2"}));
        Assert.Throws<InvalidOperationException>(()=>_storage.Preview(new[]{"../../settings.db"}));
        var plan=_storage.Preview(new[]{"content:1"});_now=_now.AddMinutes(6);Assert.Throws<InvalidOperationException>(()=>_storage.Clean(plan.PlanId));
    }
    [Test] public void RechecksBusyAndVersionChangesBeforeDeleting()
    {
        var plan=_storage.Preview(new[]{"content:1"});_busy=true;Assert.Throws<InvalidOperationException>(()=>_storage.Clean(plan.PlanId));_busy=false;
        plan=_storage.Preview(new[]{"content:1"});using var c=Open();c.Execute("UPDATE ContentVersion SET LastUsed='2030-01-01' WHERE Id=1");
        Assert.Throws<InvalidOperationException>(()=>_storage.Clean(plan.PlanId));Assert.That(c.ExecuteScalar<long>("SELECT COUNT(*) FROM ContentVersion"),Is.EqualTo(2));
    }
    [Test] public void KeepsRunningClientDataEvenWhenHostDoesNotKnowAboutIt()
    {
        using var c=Open();using var process=System.Diagnostics.Process.GetCurrentProcess();
        c.Execute("INSERT INTO RunningClient VALUES(@pid,@module,1)",new {pid=process.Id,module=process.MainModule!.FileName});
        Assert.That(_storage.Scan().BlockedReason,Is.Not.Null);Assert.Throws<InvalidOperationException>(()=>_storage.Preview(new[]{"content:1"}));
    }
    [Test] public void ChangedLogIsNotDeletedAndLocalServerDataIsReadOnly()
    {
        Directory.CreateDirectory(Path.Combine(_root,"logs"));var log=Path.Combine(_root,"logs","launcher-20200101.log");File.WriteAllText(log,"old");File.SetLastWriteTimeUtc(log,_now.AddDays(-10).UtcDateTime);
        Directory.CreateDirectory(Path.Combine(_root,"local-servers"));File.WriteAllText(Path.Combine(_root,"local-servers","world.db"),"keep");
        var scan=_storage.Scan();var item=scan.Items.Single(i=>i.Category=="logs");var plan=_storage.Preview(new[]{item.Id});File.AppendAllText(log,"changed");
        Assert.Throws<InvalidOperationException>(()=>_storage.Clean(plan.PlanId));Assert.That(File.Exists(log),Is.True);Assert.That(scan.Categories.Single(c=>c.Id=="localServers").Bytes,Is.GreaterThan(0));
    }
    [Test] public async Task DiagnosticsRedactsAddressesAndSeparatesMissingDownloadFromFailure()
    {
        var handler=new ProbeHandler();using var http=new HttpClient(handler);
        var diagnostics=new ConnectionDiagnostics(http,Path.Combine(_root,"engines"),_root);
        var result=await diagnostics.RunAsync("ss14://user:password@localhost:1212/?token=private#secret","valid",CancellationToken.None);
        var serialized=System.Text.Json.JsonSerializer.Serialize(result);
        Assert.That(serialized,Does.Not.Contain("password").And.Not.Contain("private").And.Not.Contain("user:"));
        Assert.That(result.Checks.Single(c=>c.Id=="engine").Status,Is.EqualTo("info"));Assert.That(handler.Addresses.All(a=>a.UserInfo==""&&a.Query==""),Is.True);
        Assert.That(result.Checks.Single(c=>c.Id=="server").Status,Is.EqualTo("passed"));
    }
    [Test] public async Task DiagnosticsNetworkErrorsAreStructuredAndDoNotEchoExceptions()
    {
        using var http=new HttpClient(new ProbeHandler{Fail=true});var diagnostics=new ConnectionDiagnostics(http,Path.Combine(_root,"engines"),_root);
        var result=await diagnostics.RunAsync("localhost:1212","expired",CancellationToken.None);
        Assert.That(result.Checks.Single(c=>c.Id=="server").Status,Is.EqualTo("failed"));
        Assert.That(result.Checks.Single(c=>c.Id=="account").Action,Is.EqualTo("login"));
        Assert.That(System.Text.Json.JsonSerializer.Serialize(result),Does.Not.Contain("secret-value"));
    }
    private sealed class ProbeHandler:HttpMessageHandler
    {
        public bool Fail;public bool DownloadFail;public string? BuildJson;public System.Collections.Generic.List<Uri> Addresses=new();
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)
        {
            Addresses.Add(request.RequestUri!);if(Fail)throw new HttpRequestException("token=secret-value");
            if(request.Method==HttpMethod.Head)return Task.FromResult(new HttpResponseMessage(DownloadFail?HttpStatusCode.ServiceUnavailable:HttpStatusCode.OK));
            var json=request.RequestUri!.AbsolutePath.EndsWith("status")?"{\"name\":\"Station\",\"players\":1}":"{\"build\":{\"engine_version\":\"1.2.3\",\"version\":\"1\",\"fork_id\":\"station\"},\"auth\":{\"mode\":\"Required\"}}";
            if(BuildJson!=null&&request.RequestUri.AbsolutePath.EndsWith("info"))json="{\"build\":"+BuildJson+"}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(json)});
        }
    }

    [Test] public void CleanupAndLaunchCannotAcquireConcurrentLeases()
    {
        var gate=new MaintenanceGate(()=>_busy);using(var use=gate.Use())Assert.Throws<InvalidOperationException>(()=>gate.Clean());
        using(var clean=gate.Clean())Assert.Throws<InvalidOperationException>(()=>gate.Use());
        _busy=true;Assert.Throws<InvalidOperationException>(()=>gate.Clean());_busy=false;using var final=gate.Use();
    }
    [Test] public void RejectsTraversalAndSymbolicLinkRoots()
    {
        Assert.Throws<IOException>(()=>ManagedStorage.EnsureSafe(Path.Combine(_root,"..","outside"),_root));
        // File attributes can identify a directory symlink without traversing its contents.
        var target=Path.Combine(_root,"target");Directory.CreateDirectory(target);
        var link=Path.Combine(_root,"link");
        if(OperatingSystem.IsWindows())
        {
            var start=new System.Diagnostics.ProcessStartInfo("powershell.exe"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardError=true,RedirectStandardOutput=true};
            start.ArgumentList.Add("-NoProfile");start.ArgumentList.Add("-NonInteractive");start.ArgumentList.Add("-Command");
            start.ArgumentList.Add($"$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path '{link.Replace("'","''")}' -Target '{target.Replace("'","''")}' | Out-Null");
            using var process=System.Diagnostics.Process.Start(start)!;process.WaitForExit();Assert.That(process.ExitCode,Is.Zero,process.StandardError.ReadToEnd());
        }
        else Directory.CreateSymbolicLink(link,target);
        try{Assert.Throws<IOException>(()=>ManagedStorage.EnsureSafe(Path.Combine(link,"file.log"),link));}
        finally{Directory.Delete(link);}
    }
    [Test] public async Task DiagnosesUnavailableDownloadSourceWithoutDownloadingTheArchive()
    {
        using var http=new HttpClient(new ProbeHandler{DownloadFail=true});var diagnostics=new ConnectionDiagnostics(http,Path.Combine(_root,"engines"),_root);
        var result=await diagnostics.RunAsync("localhost:1212","valid",CancellationToken.None);
        Assert.That(result.Checks.Single(c=>c.Id=="download").Status,Is.EqualTo("failed"));
    }
    [TestCase(false,"hash","https://cdn.example/manifest.txt")]
    [TestCase(true,"hash","http://localhost:1212/manifest.txt")]
    [TestCase(true,"","http://localhost:1212/client.zip")]
    public async Task DownloadProbeMatchesConnectorAndUpdaterTransport(bool acz,string hash,string expected)
    {
        var handler=new ProbeHandler{BuildJson=System.Text.Json.JsonSerializer.Serialize(new {engine_version="1.2.3",acz,manifest_hash=hash,manifest_url="https://cdn.example/manifest.txt",manifest_download_url="https://cdn.example/download",download_url="https://cdn.example/client.zip"})};
        using var http=new HttpClient(handler);var diagnostics=new ConnectionDiagnostics(http,Path.Combine(_root,"engines"),_root);
        await diagnostics.RunAsync("localhost:1212","valid",CancellationToken.None);
        Assert.That(handler.Addresses.Last().ToString(),Is.EqualTo(expected));
    }
}
