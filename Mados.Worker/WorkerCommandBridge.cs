using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Serilog;

namespace SS14.Launcher;

/// <summary>
/// Keeps the Loader/legacy launcher command protocol alive while Electron owns
/// the window. The bridge accepts one line at a time and never writes secrets
/// back to the pipe.
/// </summary>
public sealed class WorkerCommandBridge : IAsyncDisposable
{
    private readonly Func<string, Task> _command;
    private readonly CancellationTokenSource _cancel = new();
    private Task? _serverTask;
    private NamedPipeServerStream? _server;

    public WorkerCommandBridge(Func<string, Task> command) => _command = command;

    public void Start() => _serverTask = RunAsync();

    private async Task RunAsync()
    {
        var pipeName = GetPipeName();
        try
        {
            while (!_cancel.IsCancellationRequested)
            {
                try
                {
                    _server = new NamedPipeServerStream(pipeName, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await _server.WaitForConnectionAsync(_cancel.Token);
                    using var reader = new StreamReader(_server, Encoding.UTF8, leaveOpen: false);
                    while (await reader.ReadLineAsync(_cancel.Token) is { } line)
                    {
                        if (!string.IsNullOrWhiteSpace(line)) await _command(line);
                    }
                }
                catch (OperationCanceledException) when (_cancel.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception error)
                {
                    Log.Warning(error, "Legacy Loader command bridge failed");
                    await Task.Delay(250, _cancel.Token);
                }
                finally
                {
                    _server?.Dispose();
                    _server = null;
                }
            }
        }
        catch (OperationCanceledException) when (_cancel.IsCancellationRequested)
        {
        }
    }

    public async ValueTask DisposeAsync()
    {
        _cancel.Cancel();
        _server?.Dispose();
        if (_serverTask != null)
        {
            try { await _serverTask; } catch (OperationCanceledException) { }
        }
        _cancel.Dispose();
    }

    private static string GetPipeName()
    {
        var actual = ConfigConstants.LauncherCommandsNamedPipeName;
        if (OperatingSystem.IsLinux() && Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR") is { Length: > 0 } runtime)
            return Path.Combine(runtime, actual);
        if (!OperatingSystem.IsMacOS())
            actual += "_" + Convert.ToHexString(Encoding.UTF8.GetBytes(Environment.UserName));
        return actual;
    }
}
