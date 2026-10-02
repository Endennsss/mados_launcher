using System;
using System.Threading;
using System.Threading.Tasks;
using Avalonia.Platform.Storage;
using Serilog;

namespace SS14.Launcher.Models;

public partial class Connector
{
    public void LaunchContentBundle(IStorageFile file, CancellationToken cancel = default)
    {
        _ = LaunchContentBundleAsync(file, cancel);
    }

    public async Task LaunchContentBundleAsync(IStorageFile file, CancellationToken cancel = default)
    {
        Log.Information("Launching content bundle: {FileName}", file.Path);

        try
        {
            await LaunchContentBundleInternal(async () => await file.OpenReadAsync(), file.TryGetLocalPath(), cancel);
        }
        catch (ConnectException e)
        {
            Log.Error(e, "Failed to launch: {status}", e.Status);
            Status = e.Status;
        }
        catch (OperationCanceledException e)
        {
            Log.Information(e, "Cancelled launch");
            Status = ConnectionStatus.Cancelled;
        }
        finally
        {
            Cleanup();
        }
    }

}
