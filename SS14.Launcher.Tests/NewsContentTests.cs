using System.Text.Json;
using System;
using System.Linq;
using NUnit.Framework;
using SS14.Launcher.Worker;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class NewsContentTests
{
    [Test]
    public void KeepsLatestStableEvenAfterManyNewerPostsAndDeduplicatesIt()
    {
        var stable = new NewsEntry("Stable", "https://github.com/Endennsss/mados_launcher/releases/tag/v1", DateTime.UtcNow.AddDays(-30), "GitHub · Mados Launcher", null, Version:"v1", IsLatestStable:true);
        var recent = Enumerable.Range(0, 25).Select(i => new NewsEntry("Post", $"https://example.com/{i}", DateTime.UtcNow, "Space Station 14", null));
        var selected = NewsContent.SelectForFeed(recent.Append(stable with { IsLatestStable=false }).Append(stable));
        Assert.That(selected.Count, Is.EqualTo(20));
        Assert.That(selected[0], Is.EqualTo(stable));
        Assert.That(selected.Count(item => item.Link == stable.Link), Is.EqualTo(1));
    }
    [Test]
    public void KeepsFullReleaseBodyAndExplicitVersion()
    {
        var body = "## Changes\n- " + new string('a', 500);
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(new {html_url="https://github.com/Endennsss/mados_launcher/releases/tag/v0.42.0",tag_name="v0.42.0",name="Mados",body,prerelease=true}));
        var item = NewsContent.FromGitHub(json.RootElement)!;
        Assert.That(item.Body, Is.EqualTo(body));Assert.That(item.Version, Is.EqualTo("v0.42.0"));Assert.That(item.Prerelease, Is.True);Assert.That(item.Summary!.Length, Is.LessThanOrEqualTo(220));
    }
    [Test]
    public void ConvertsFeedMarkupToReadableTextWithoutExecutingOrKeepingScripts()
    {
        var body = NewsContent.PlainText("<p>First &amp; second</p><p>Next paragraph</p><script>alert('x')</script><style>body{}</style>");
        Assert.That(body, Is.EqualTo("First & second\n\nNext paragraph"));
        Assert.That(NewsContent.LimitBody(new string('a', 65000))!.Length, Is.EqualTo(64000));
    }
    [TestCase("https://github.com/Endennsss/mados_launcher/releases/tag/v1", true)]
    [TestCase("javascript:alert(1)", false)]
    [TestCase("https://other.example/release", false)]
    public void RejectsDraftsAndInvalidReleaseLinks(string link, bool valid)
    {
        using var json=JsonDocument.Parse(JsonSerializer.Serialize(new {html_url=link,draft=false}));
        Assert.That(NewsContent.FromGitHub(json.RootElement) != null, Is.EqualTo(valid));
        using var draft=JsonDocument.Parse(JsonSerializer.Serialize(new {html_url=link,draft=true}));
        Assert.That(NewsContent.FromGitHub(draft.RootElement), Is.Null);
    }
}
