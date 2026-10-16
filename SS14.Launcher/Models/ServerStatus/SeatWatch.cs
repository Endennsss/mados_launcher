using System;
using System.Threading;
using System.Threading.Tasks;

namespace SS14.Launcher.Models.ServerStatus;
public sealed record SeatProbe(int? Players,int? Limit);
public sealed record SeatWatchState(string Status,string? AccountId=null,string? Address=null,string? Name=null,int? Players=null,int? Limit=null,string? ExpiresAt=null,string? Message=null);
public sealed class SeatWatch(Func<string,CancellationToken,Task<SeatProbe>> probe,Action<SeatWatchState> changed,Action<SeatWatchState> available,Func<DateTimeOffset>? clock=null)
{
    private readonly object _gate=new();
    private readonly Func<DateTimeOffset> _clock=clock??(()=>DateTimeOffset.UtcNow);
    private int _generation;
    private SeatWatchState _state=new("idle");
    public SeatWatchState Snapshot{get{lock(_gate)return _state;}}
    public bool Active=>Snapshot.Status is "watching" or "checking" or "unknown" or "offline";
    public void Start(string account,string address,string name)
    {
        address=PresenceAddress.Sanitize(address)??throw new InvalidOperationException("Неверный адрес сервера.");
        lock(_gate){_generation++;_state=new("checking",account,address,name,ExpiresAt:_clock().AddMinutes(30).ToString("O"));changed(_state);}
    }
    public void Stop(){lock(_gate){_generation++;_state=new("idle");changed(_state);}}
    public async Task PollAsync(CancellationToken cancel)
    {
        int generation;SeatWatchState current;
        lock(_gate){if(!Active)return;current=_state;generation=_generation;if(_clock()>=DateTimeOffset.Parse(current.ExpiresAt!)){_state=current with{Status="expired",Message="Ожидание завершено через 30 минут."};changed(_state);return;}}
        SeatProbe? result=null;
        try{result=await probe(current.Address!,cancel);}catch(OperationCanceledException)when(cancel.IsCancellationRequested){return;}catch(System.Net.Http.HttpRequestException){}catch(OperationCanceledException){}catch(System.Text.Json.JsonException){}
        lock(_gate)
        {
            if(generation!=_generation||cancel.IsCancellationRequested)return;
            if(_clock()>=DateTimeOffset.Parse(current.ExpiresAt!)){_state=current with{Status="expired",Message="Ожидание завершено через 30 минут."};changed(_state);return;}
            var free=result?.Players is >=0&&result.Limit is >0&&result.Players<result.Limit;
            var status=result==null?"offline":result.Limit is not >0?"unknown":free?"available":"watching";
            _state=current with{Status=status,Players=result?.Players,Limit=result?.Limit,Message=status switch{"offline"=>"Сервер не ответил. Повторим проверку.","unknown"=>"Сервер не сообщает лимит игроков.","available"=>"По данным сервера есть место. Вход не гарантирован.",_=>"Проверяем каждые 30 секунд."}};
            changed(_state);if(free)available(_state);
        }
    }
}
