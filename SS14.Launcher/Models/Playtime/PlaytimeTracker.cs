using System;
using System.Threading;
using SS14.Launcher.Models;

namespace SS14.Launcher.Models.Playtime;

/// <summary>
/// Converts the connector's real client lifecycle into durable playtime
/// sessions. No UI timers or estimated download progress participate here.
/// </summary>
public sealed class PlaytimeTracker : IDisposable
{
    private readonly PlaytimeStore _store;
    private readonly Action<PlaytimeUpdate> _updated;
    private readonly object _gate = new();
    private readonly Timer _heartbeat;
    private PendingSession? _pending;
    private ActiveSession? _active;
    private bool _disposed;

    public PlaytimeTracker(PlaytimeStore store, Action<PlaytimeUpdate> updated)
    {
        _store = store;
        _updated = updated;
        _heartbeat = new Timer(Heartbeat, null, TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(15));
    }

    public void Prepare(Guid? accountId, string address, string? serverName, bool countable)
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            _pending = countable && accountId is { } id && id != Guid.Empty
                ? new PendingSession(id, address, serverName)
                : null;
        }
    }

    public void ObserveStatus(Connector.ConnectionStatus status)
    {
        PlaytimeUpdate? update = null;
        lock (_gate)
        {
            if (_disposed)
                return;

            if (status == Connector.ConnectionStatus.ClientRunning && _active == null && _pending is { } pending)
            {
                var startedAt = DateTimeOffset.UtcNow;
                var id = _store.StartSession(pending.AccountId, pending.Address, pending.ServerName, startedAt);
                _active = new ActiveSession(id, pending.AccountId, pending.Address, pending.ServerName, startedAt);
                update = ToUpdate(_active, startedAt);
            }
            else if (status is Connector.ConnectionStatus.ClientExited or Connector.ConnectionStatus.ConnectionFailed or Connector.ConnectionStatus.Cancelled or Connector.ConnectionStatus.UpdateError or Connector.ConnectionStatus.NotAContentBundle)
            {
                update = EndActive("client_exited");
                _pending = null;
            }
        }

        if (update is not null)
            _updated(update);
    }

    public void Stop()
    {
        PlaytimeUpdate? update;
        lock (_gate)
        {
            if (_disposed)
                return;

            update = EndActive("worker_shutdown");
            _pending = null;
            _disposed = true;
        }

        _heartbeat.Dispose();
        if (update is not null)
            _updated(update with { Active = false });
    }

    public void Dispose() => Stop();

    private void Heartbeat(object? _)
    {
        PlaytimeUpdate? update = null;
        lock (_gate)
        {
            if (_disposed || _active is not { } active)
                return;

            var now = DateTimeOffset.UtcNow;
            _store.Heartbeat(active.Id, now);
            update = ToUpdate(active, now);
        }

        if (update is not null)
            _updated(update);
    }

    private PlaytimeUpdate? EndActive(string reason)
    {
        if (_active is not { } active)
            return null;

        var endedAt = DateTimeOffset.UtcNow;
        _store.EndSession(active.Id, endedAt, reason);
        _active = null;
        return ToUpdate(active, endedAt) with { Active = false };
    }

    private static PlaytimeUpdate ToUpdate(ActiveSession active, DateTimeOffset now)
        => new(
            active.AccountId,
            active.Address,
            active.ServerName,
            active.StartedAt,
            Math.Max(0, (long)Math.Floor((now - active.StartedAt).TotalSeconds)),
            true);

    private void ThrowIfDisposed()
    {
        if (_disposed)
            throw new ObjectDisposedException(nameof(PlaytimeTracker));
    }

    private sealed record PendingSession(Guid AccountId, string Address, string? ServerName);

    private sealed record ActiveSession(string Id, Guid AccountId, string Address, string? ServerName, DateTimeOffset StartedAt);
}

public sealed record PlaytimeUpdate(
    Guid AccountId,
    string Address,
    string? Name,
    DateTimeOffset StartedAt,
    long ElapsedSeconds,
    bool Active);
