using System;
using System.Threading;
using System.Threading.Tasks;

namespace SS14.Launcher.Worker;

/// <summary>Preserves manual refresh order, including time spent waiting for hub data.</summary>
public sealed class FavoriteMonitoringQueue
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<T> RunAsync<T>(Func<Task<T>> refresh, CancellationToken cancel)
    {
        await _gate.WaitAsync(cancel);
        try
        {
            cancel.ThrowIfCancellationRequested();
            return await refresh();
        }
        finally
        {
            _gate.Release();
        }
    }
}
