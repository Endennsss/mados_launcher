using NUnit.Framework;
using System.Text.Json;
using SS14.Launcher.Api;
using SS14.Launcher.Models.ServerStatus;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class ServerStatusSnapshotTests
{
    [Test]
    public void UnexpectedOptionalMetadataDoesNotBreakTheServerList()
    {
        var status = JsonSerializer.Deserialize<ServerApi.ServerStatus>("""
            {"name":"Station", "players":12, "tags":["map:Box","mode:Sandbox"],
             "map":["not a supported string"], "preset":{"name":"not a supported string"}}
            """)!;
        var snapshot = ServerStatusSnapshot.FromStatus(status, 20);
        Assert.That(snapshot.Name, Is.EqualTo("Station"));
        Assert.That(snapshot.PlayerCount, Is.EqualTo(12));
        Assert.That(snapshot.Map, Is.EqualTo("Box"));
        Assert.That(snapshot.Mode, Is.EqualTo("Sandbox"));
    }

    [Test]
    public void ReadsPublicMapAndPresetFieldsUsedByFishStation()
    {
        var status = JsonSerializer.Deserialize<ServerApi.ServerStatus>("""
            {"name":"🐟 РЫБЬЯ СТАНЦИЯ: ПЕРСЕЙ", "players":29, "soft_max_players":140,
             "tags":["lang:ru","rp:low","mrp"], "map":"Marathon", "preset":"Рассказчик: Безумный"}
            """)!;
        var snapshot = ServerStatusSnapshot.FromStatus(status, 37);
        Assert.Multiple(() =>
        {
            Assert.That(snapshot.Name, Is.EqualTo("🐟 РЫБЬЯ СТАНЦИЯ: ПЕРСЕЙ"));
            Assert.That(snapshot.Map, Is.EqualTo("Marathon"));
            Assert.That(snapshot.Mode, Is.EqualTo("Рассказчик: Безумный"));
        });
    }

    [Test]
    public void ExplicitStatusFieldsTakePriorityOverStaticTags()
    {
        var status = JsonSerializer.Deserialize<ServerApi.ServerStatus>("""
            {"tags":["map:Box","mode:Sandbox"],"map":"  Marathon  ","preset":"  Secret  "}
            """)!;
        var snapshot = ServerStatusSnapshot.FromStatus(status, null);
        Assert.That(snapshot.Map, Is.EqualTo("Marathon"));
        Assert.That(snapshot.Mode, Is.EqualTo("Secret"));
    }

    [Test]
    public void MissingOrBlankFieldsFallBackToTagsWithoutUsingRoleplayLevel()
    {
        var status = JsonSerializer.Deserialize<ServerApi.ServerStatus>("""
            {"tags":["map:Box","rp:low"],"map":" ","preset":null}
            """)!;
        var snapshot = ServerStatusSnapshot.FromStatus(status, null);
        Assert.That(snapshot.Map, Is.EqualTo("Box"));
        Assert.That(snapshot.Mode, Is.Null);
    }

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
