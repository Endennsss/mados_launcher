using NUnit.Framework;
using SS14.Launcher.Models.ServerStatus;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class PresenceAddressTests
{
    [TestCase("ss14://user:password@station.example/round?ticket=secret#private", "ss14://station.example/round")]
    [TestCase("https://user:password@station.example/client.zip?ticket=secret#private", "https://station.example/client.zip")]
    [TestCase("access_token=secret", "access_token=[redacted]")]
    [TestCase("not a URI?ticket=secret", "[invalid address]")]
    public void SanitizesRawLogArguments(string argument, string expected)
    {
        Assert.That(PresenceAddress.SanitizeForLog(argument), Is.EqualTo(expected));
    }

    [Test]
    public void RemovesCredentialsQueryAndFragment()
    {
        var sanitized = PresenceAddress.Sanitize("ss14://user:password@station.example:1212/path?token=secret#round");

        Assert.That(sanitized, Is.EqualTo("ss14://station.example:1212/path"));
        Assert.That(sanitized, Does.Not.Contain("secret"));
        Assert.That(sanitized, Does.Not.Contain("password"));
    }

    [Test]
    public void RedactsEmbeddedUrlArgumentsForLogs()
    {
        var sanitized = PresenceAddress.SanitizeForLog("build.download_url=https://user:password@station.example/client.zip?token=secret#round");

        Assert.That(sanitized, Is.EqualTo("build.download_url=https://station.example/client.zip"));
        Assert.That(sanitized, Does.Not.Contain("secret"));
        Assert.That(sanitized, Does.Not.Contain("password"));
    }
}
