using NUnit.Framework;
using SS14.Launcher.Models.ServerStatus;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class PresenceAddressTests
{
    [Test]
    public void RemovesCredentialsQueryAndFragment()
    {
        var sanitized = PresenceAddress.Sanitize("ss14://user:password@station.example:1212/path?token=secret#round");

        Assert.That(sanitized, Is.EqualTo("ss14://station.example:1212/path"));
        Assert.That(sanitized, Does.Not.Contain("secret"));
        Assert.That(sanitized, Does.Not.Contain("password"));
    }
}
