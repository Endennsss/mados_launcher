using System;
using System.Threading;
using System.Threading.Tasks;
using Serilog;
using SS14.Launcher.Models.ServerStatus;

namespace SS14.Launcher.Models.Presence;

public sealed record PresenceSnapshot(
    string State, bool Enabled, bool ShowNickname, string? AccountName,
    string? ServerName, string? Address, int? PlayerCount, int? SoftMaxPlayerCount,
    long? PingMs, string? Map, string? Mode, DateTimeOffset? StartedAt);

/// <summary>Owns the real connector lifecycle. Neither UI timers nor Discord connectivity start a game session.</summary>
public sealed class PresenceTracker : IDisposable
{
    private readonly object _gate = new();
    private readonly Func<string, CancellationToken, Task<ServerStatusSnapshot?>> _fetch;
    private readonly Action<PresenceSnapshot> _publish;
    private readonly Action<string, ServerStatusSnapshot> _cache;
    private readonly TimeSpan _interval;
    private CancellationTokenSource? _poll;
    private Session? _session;
    private string _state = "launcher";
    private string? _menuAccount;
    private bool _enabled = true;
    private bool _showNickname = true;
    private bool _disposed;

    public PresenceTracker(
        Func<string, CancellationToken, Task<ServerStatusSnapshot?>> fetch,
        Action<PresenceSnapshot> publish,
        Action<string, ServerStatusSnapshot> cache,
        TimeSpan? interval = null)
    {
        _fetch = fetch;
        _publish = publish;
        _cache = cache;
        _interval = interval ?? TimeSpan.FromSeconds(30);
    }

    public void Configure(bool enabled, bool showNickname, string? menuAccount)
    {
        lock (_gate)
        {
            if (_disposed) return;
            _enabled = enabled;
            _showNickname = showNickname;
            _menuAccount = menuAccount;
            if (!enabled) CancelPollingLocked();
            PublishLocked();
            if (enabled && _state == "playing") StartPollingLocked();
        }
    }

    public void Prepare(string? address, string? serverName, string? accountName, ServerStatusSnapshot? snapshot = null)
    {
        lock (_gate)
        {
            if (_disposed) return;
            CancelPollingLocked();
            // Null is used for ZIPs/replays. They never create a presence session.
            var safeAddress = PresenceAddress.Sanitize(address);
            _session = safeAddress == null ? null : new Session(safeAddress, serverName, accountName, snapshot);
            _state = _session == null ? "launcher" : "connecting";
            PublishLocked();
        }
    }

    public void ObserveStatus(Connector.ConnectionStatus status)
    {
        lock (_gate)
        {
            if (_disposed) return;
            if (status is Connector.ConnectionStatus.ClientExited or Connector.ConnectionStatus.ConnectionFailed
                or Connector.ConnectionStatus.UpdateError or Connector.ConnectionStatus.Cancelled or Connector.ConnectionStatus.NotAContentBundle)
            {
                CancelPollingLocked();
                _session = null;
                _state = "launcher";
            }
            else if (_session is { } session)
            {
                switch (status)
                {
                    case Connector.ConnectionStatus.ClientRunning:
                        session.StartedAt ??= DateTimeOffset.UtcNow;
                        _state = "playing";
                        break;
                    case Connector.ConnectionStatus.Updating:
                        _state = "updating";
                        break;
                    case Connector.ConnectionStatus.Connecting:
                    case Connector.ConnectionStatus.AwaitingPrivacyPolicyAcceptance:
                    case Connector.ConnectionStatus.StartingClient:
                        _state = "connecting";
                        break;
                }
            }
            PublishLocked();
            if (_state == "playing" && _enabled) StartPollingLocked();
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            CancelPollingLocked();
            _session = null;
            _state = "launcher";
            _enabled = false;
            PublishLocked();
        }
    }

    private void StartPollingLocked()
    {
        if (_poll != null || _session == null) return;
        var source = new CancellationTokenSource();
        _poll = source;
        var session = _session;
        _ = Task.Run(() => PollAsync(session, source));
    }

    private void CancelPollingLocked()
    {
        _poll?.Cancel();
        _poll = null; // The cancelled loop disposes its own CTS after its in-flight request ends.
    }

    private async Task PollAsync(Session session, CancellationTokenSource source)
    {
        var cancel = source.Token;
        try
        {
            using var timer = new PeriodicTimer(_interval);
            do
            {
                cancel.ThrowIfCancellationRequested();
                ServerStatusSnapshot? snapshot;
                try
                {
                    snapshot = await _fetch(session.Address, cancel);
                }
                catch (OperationCanceledException) when (cancel.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception error)
                {
                    // A malformed/unavailable status must not permanently stop later refreshes.
                    Log.Debug("Presence status unavailable ({ErrorType})", error.GetType().Name);
                    snapshot = null;
                }
                lock (_gate)
                {
                    if (cancel.IsCancellationRequested || _disposed || !_enabled || _poll != source || _session != session)
                        return;
                    session.Snapshot = snapshot; // Unavailable status is unknown, never a stale ping.
                    if (snapshot != null) _cache(session.Address, snapshot);
                    PublishLocked();
                }
            } while (await timer.WaitForNextTickAsync(cancel));
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            // Client exit, opt-out or worker shutdown cancels a pending probe.
        }
        finally
        {
            lock (_gate)
            {
                if (_poll == source) _poll = null;
                source.Dispose();
            }
        }
    }

    private void PublishLocked()
    {
        var session = _enabled ? _session : null;
        var snapshot = session?.Snapshot;
        var name = string.IsNullOrWhiteSpace(snapshot?.Name) ? session?.Name : snapshot.Name;
        _publish(new PresenceSnapshot(
            _state, _enabled, _showNickname,
            _enabled && _showNickname ? (session == null ? _menuAccount : session.Account) : null,
            name, session?.Address, snapshot?.PlayerCount, snapshot?.SoftMaxPlayerCount,
            snapshot?.PingMs, snapshot?.Map, snapshot?.Mode,
            _state == "playing" ? session?.StartedAt : null));
    }

    private sealed class Session(string address, string? name, string? account, ServerStatusSnapshot? snapshot)
    {
        public string Address { get; } = address;
        public string? Name { get; } = name;
        public string? Account { get; } = account;
        public ServerStatusSnapshot? Snapshot { get; set; } = snapshot;
        public DateTimeOffset? StartedAt { get; set; }
    }
}
