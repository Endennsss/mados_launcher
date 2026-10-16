using System;
using System.Threading;

namespace SS14.Launcher.Models.Maintenance;

/// <summary>Prevents a cleanup from overlapping a launch/import, including legacy bridge calls.</summary>
public sealed class MaintenanceGate(Func<bool> busy)
{
    private readonly object _gate=new();
    private int _users;
    private bool _cleaning;
    public IDisposable Use()
    {
        lock(_gate){if(_cleaning)throw new InvalidOperationException("Дождитесь завершения очистки хранилища.");_users++;return new Lease(()=>{lock(_gate)_users--;});}
    }
    public IDisposable Clean()
    {
        lock(_gate){if(_cleaning||_users>0||busy())throw new InvalidOperationException("Закройте игру и дождитесь завершения текущих операций перед очисткой.");_cleaning=true;return new Lease(()=>{lock(_gate)_cleaning=false;});}
    }
    private sealed class Lease(Action release):IDisposable
    {
        private Action? _release=release;
        public void Dispose()=>Interlocked.Exchange(ref _release,null)?.Invoke();
    }
}
