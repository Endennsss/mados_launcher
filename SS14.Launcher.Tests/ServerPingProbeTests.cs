using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using SS14.Launcher.Models.ServerStatus;

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class ServerPingProbeTests
{
    [Test]
    public async Task MeasuresTheStatusEndpointForTheSpecificServer()
    {
        var requests = new List<Uri>();
        using var client = new HttpClient(new RecordingHandler(requests));

        var ping = await ServerPingProbe.MeasureAsync(client, "ss14://alpha.example:1212", CancellationToken.None);

        Assert.That(ping, Is.Not.Null);
        Assert.That(requests, Has.Count.EqualTo(1));
        Assert.That(requests[0].AbsoluteUri, Is.EqualTo("http://alpha.example:1212/status"));
    }

    [Test]
    public async Task ReturnsNullWhenTheServerStatusRequestFails()
    {
        using var client = new HttpClient(new RecordingHandler(new List<Uri>(), HttpStatusCode.ServiceUnavailable));

        var ping = await ServerPingProbe.MeasureAsync(client, "ss14://offline.example:1212", CancellationToken.None);

        Assert.That(ping, Is.Null);
    }

    private sealed class RecordingHandler(List<Uri> requests, HttpStatusCode statusCode = HttpStatusCode.OK) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            requests.Add(request.RequestUri!);
            return Task.FromResult(new HttpResponseMessage(statusCode));
        }
    }
}
