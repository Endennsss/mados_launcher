using NUnit.Framework;
using SS14.Launcher.Api;
using SS14.Launcher.Models.ServerStatus;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class ServerStatusSnapshotTests
{
    [Test]
    public void ReadsMapModeAndLanguageOnlyFromExplicitTags()
    {
        var status = new ServerApi.ServerStatus(
            "Mados Station",
            42,
            80,
            "2026-10-02T12:00:00Z",
            ServerApi.GameRunLevel.InRound,
            ["lang:ru", "map:Box", "mode:Roleplay", "region:eu"]);

        var snapshot = ServerStatusSnapshot.FromStatus(status, 37);

        Assert.That(snapshot.Name, Is.EqualTo("Mados Station"));
        Assert.That(snapshot.PlayerCount, Is.EqualTo(42));
        Assert.That(snapshot.SoftMaxPlayerCount, Is.EqualTo(80));
        Assert.That(snapshot.Language, Is.EqualTo("ru"));
        Assert.That(snapshot.Map, Is.EqualTo("Box"));
        Assert.That(snapshot.Mode, Is.EqualTo("Roleplay"));
        Assert.That(snapshot.PingMs, Is.EqualTo(37));
    }

    [Test]
    public void MissingMapAndModeRemainUnknown()
    {
        var status = new ServerApi.ServerStatus("Station", 0, 0, null, null, ["lang:en"]);

        var snapshot = ServerStatusSnapshot.FromStatus(status, null);

        Assert.That(snapshot.Map, Is.Null);
        Assert.That(snapshot.Mode, Is.Null);
        Assert.That(snapshot.PingMs, Is.Null);
    }
}
