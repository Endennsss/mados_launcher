using NUnit.Framework;
using System.Text.Json;
using SS14.Launcher.Utility;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class WorkerProtocolTests
{
    [TestCase("[]", "INVALID_REQUEST")]
    [TestCase("null", "INVALID_REQUEST")]
    [TestCase("{\"v\":1,\"id\":\"a\",\"method\":123}", "INVALID_REQUEST")]
    [TestCase("{\"v\":1,\"id\":{},\"method\":\"app.getState\"}", "INVALID_REQUEST")]
    [TestCase("{\"v\":2,\"id\":\"a\",\"method\":\"app.getState\"}", "UNSUPPORTED_VERSION")]
    [TestCase("{\"v\":1,\"id\":\"a\",\"method\":\"app.getState\"}", null)]
    public void RejectsMalformedRequestsWithoutThrowing(string json, string expected)
    {
        using var document = JsonDocument.Parse(json);
        Assert.That(WorkerProtocol.ValidateRequest(document.RootElement), Is.EqualTo(expected));
    }

    [TestCase(1, true)]
    [TestCase(0, false)]
    [TestCase(2, false)]
    public void AcceptsOnlyVersionOne(int version, bool expected)
    {
        Assert.That(WorkerProtocol.IsSupportedVersion(version), Is.EqualTo(expected));
    }
}
