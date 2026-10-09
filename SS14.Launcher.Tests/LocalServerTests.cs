using System;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using SS14.Launcher.Worker;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class LocalServerTests
{
    private string _directory = null!;

    [SetUp]
    public void SetUp()
    {
        _directory = Path.Combine(Path.GetTempPath(), "mados-local-server-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_directory);
    }

    [TearDown]
    public void TearDown()
    {
        try { Directory.Delete(_directory, true); } catch { }
    }

    [Test]
    public void StoreCreatesSchemaAndRoundTripsProfile()
    {
        var store = new LocalServerStore(Path.Combine(_directory, "launcher-tools.db"));
        var now = DateTimeOffset.UtcNow;
        var profile = new LocalServerProfile("p1", "Test", "file://local", Path.Combine(_directory, "server"), "1.0", "windows", "x64", 1212, "127.0.0.1", Path.Combine(_directory, "server", "data"), Path.Combine(_directory, "server", "server_config.toml"), now, now, null);

        store.Create(profile);

        var loaded = store.Find("p1");
        Assert.That(loaded, Is.Not.Null);
        Assert.That(loaded!.Port, Is.EqualTo(1212));
        Assert.That(store.ListProfiles(), Has.Count.EqualTo(1));
        Assert.That(File.Exists(Path.Combine(_directory, "launcher-tools.db")), Is.True);
    }

    [Test]
    public void TomlValidationRejectsMalformedLinesAndAcceptsConfig()
    {
        Assert.That(LocalServerManager.ValidateToml("[net]\nport = 1212\nbind = \"127.0.0.1\"\n", out _), Is.True);
        Assert.That(LocalServerManager.ValidateToml("[net\nport = 1212", out var error), Is.False);
        Assert.That(error, Does.Contain("Строка"));
        Assert.That(LocalServerManager.ValidateToml("port = \"unterminated", out _), Is.False);
    }

    [Test]
    public void TomlParserPreservesValidArraysAndProtectsSecrets()
    {
        const string original = "[net]\nport = 1212\nbindto = \"127.0.0.1\"\n\n[auth]\nmode = 1\ntoken = \"keep-me\"\n\n[game]\nmaxplayers = 80\nroles = [\"admin\", \"moderator\"]\n";
        var config = LocalServerConfig.Read(original, "Test", 1212);
        Assert.That(config.RawToml, Does.Contain("<stored by Mados>"));
        var merged = LocalServerConfig.MergeRaw(original, config.RawToml, 1212);
        Assert.That(merged, Does.Contain("keep-me"));
        Assert.That(merged, Does.Contain("127.0.0.1:1212"));
        Assert.That(LocalServerManager.ValidateToml(merged, out var error), Is.True, error);
        var required = LocalServerConfig.Merge(original, config with { AuthMode = "Required" });
        Assert.That(required, Does.Contain("mode = 2"));
    }

    [Test]
    public void ConfigRejectsNonLoopbackBinding()
    {
        Assert.Throws<LocalServerException>(() => LocalServerConfig.ProtectLocal("[net]\nport = 1212\n", 1212, "0.0.0.0"));
    }

    [Test]
    public void PortProbeUsesLoopback()
    {
        Assert.That(LocalServerManager.IsPortAvailable("127.0.0.1", 0), Is.True);
    }

    [Test]
    public async Task ImportUpdatePreservesDataAndCreatesRollbackBackup()
    {
        var managedRoot = Path.Combine(_directory, "managed");
        var store = new LocalServerStore(Path.Combine(_directory, "tools.db"));
        await using var manager = new LocalServerManager(new HttpClient(), store, managedRoot);
        var first = CreateArchive("first", "first-value");
        var profile = await manager.ImportAsync(first, null, null, "Test server", 1212);
        Directory.CreateDirectory(profile.DataPath);
        await File.WriteAllTextAsync(Path.Combine(profile.DataPath, "keep.txt"), "keep");
        var second = CreateArchive("second", "second-value");

        var updated = await manager.ImportAsync(second, null, profile.Id, null, 1213);

        Assert.That(await File.ReadAllTextAsync(Path.Combine(updated.DataPath, "keep.txt")), Is.EqualTo("keep"));
        Assert.That(await File.ReadAllTextAsync(updated.ConfigPath), Does.Contain("first-value"));
        var backups = manager.ListBackups(profile.Id);
        Assert.That(backups, Is.Not.Empty);
        await File.WriteAllTextAsync(updated.ConfigPath, "[net]\nport = 9999\n");
        await manager.RollbackAsync(profile.Id, backups[0].Id);
        Assert.That(await File.ReadAllTextAsync(updated.ConfigPath), Does.Contain("first-value"));
    }

    [Test]
    public async Task SavingConfigKeepsProfileMetadataForLaterUpdates()
    {
        var store = new LocalServerStore(Path.Combine(_directory, "config-tools.db"));
        await using var manager = new LocalServerManager(new HttpClient(), store, Path.Combine(_directory, "config-managed"));
        var archive = CreateArchive("config", "config-value");
        var profile = await manager.ImportAsync(archive, null, null, "Config server", 1212);

        var config = await manager.GetConfigurationAsync(profile.Id);
        var saved = await manager.SaveConfigurationAsync(profile.Id, config with { Port = 23232 }, CancellationToken.None);

        Assert.That(saved.Port, Is.EqualTo(23232));
        Assert.That(manager.ListProfiles()[0].Port, Is.EqualTo(23232));
        var updated = await manager.ImportAsync(archive, null, profile.Id, null, null);
        Assert.That(updated.Port, Is.EqualTo(23232));
        Assert.That((await manager.GetConfigurationAsync(profile.Id)).Port, Is.EqualTo(23232));
    }

    [Test]
    public async Task CdnPageExtractsHashPlatformArchitectureAndSize()
    {
        const string html = "<div class=\"build\"><span>Version:</span> abc123 <a href=\"/fork/demo/version/abc123/file/SS14.Server_win-x64.zip\">Windows x64</a> (12.5 MiB)</div>";
        using var http = new HttpClient(new StubHandler(html));
        await using var manager = new LocalServerManager(http, new LocalServerStore(Path.Combine(_directory, "tools-cdn.db")), Path.Combine(_directory, "managed-cdn"));
        var inspection = await manager.InspectAsync("https://cdn.test/fork/demo");
        Assert.That(inspection.Variants, Has.Count.EqualTo(1));
        Assert.That(inspection.Variants[0].Version, Is.EqualTo("abc123"));
        Assert.That(inspection.Variants[0].Platform, Is.EqualTo("windows"));
        Assert.That(inspection.Variants[0].Architecture, Is.EqualTo("x64"));
        Assert.That(inspection.Variants[0].SizeBytes, Is.EqualTo(13_107_200));
    }

    private string CreateArchive(string name, string marker)
    {
        var build = Path.Combine(_directory, "build-" + name);
        Directory.CreateDirectory(build);
        File.WriteAllText(Path.Combine(build, "Robust.Server.dll"), "dummy");
        File.WriteAllText(Path.Combine(build, "server_config.toml"), $"[net]\nport = 1212\nbindto = \"127.0.0.1\"\n[game]\nmarker = \"{marker}\"\n");
        var archive = Path.Combine(_directory, name + ".zip");
        ZipFile.CreateFromDirectory(build, archive);
        return archive;
    }

    private sealed class StubHandler(string content) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(content) });
    }
}


