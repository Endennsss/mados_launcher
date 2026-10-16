using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Dapper;
using Microsoft.Data.Sqlite;
using Serilog;
using SS14.Launcher.Models.Data;
using SS14.Launcher.Models.Maintenance;
using SS14.Launcher.Models.Personal;
using SS14.Launcher.Models.Replays;
using SS14.Launcher.Models.ServerStatus;

namespace SS14.Launcher.Worker;
public sealed partial class WorkerHost
{
    private static bool IsMaintenanceMethod(string method)=>new[]{"storage.","diagnostics.","cache.","replays.","personal.","seatWatch."}.Any(method.StartsWith);
    private void EnsureCacheReadyForLaunch(){if(_cacheState.Stage=="ready")throw new InvalidOperationException("Кэш перенесён. Перезапустите Mados перед запуском игры.");}
    private object GetWindowSettings()=>new{minimizeOnPlay=_data.GetCVar(CVars.MinimizeOnPlay),restoreAfterPlay=_data.GetCVar(CVars.RestoreAfterPlay)};
    private CacheTransfer _cacheTransfer=null!;
    private CacheTransferState _cacheState=new("idle",0,0,null);
    private string[] _cacheWarnings=Array.Empty<string>();
    private IDisposable? _cacheLease;
    private CancellationTokenSource? _cacheCancellation;
    private ReplayLibrary _replays=null!;
    private SeatWatch _seatWatch=null!;
    private Task? _seatLoop;
    private CancellationTokenSource? _seatCancellation;
    private void InitializeToolkit()
    {
        _cacheTransfer=new CacheTransfer(Path.Combine(LauncherPaths.DirUserData,"migration-v1.json"));
        _replays=new ReplayLibrary(Path.Combine(LauncherPaths.DirUserData,"replay-library.db"));
        _seatWatch=new SeatWatch(async(address,cancel)=>{
            var status=await ServerStatusProbe.FetchAsync(_http,address,cancel);
            if(status==null)throw new System.Net.Http.HttpRequestException();
            return new SeatProbe(status.PlayerCount,status.SoftMaxPlayerCount);
        },snapshot=>SendEvent("seatWatch.updated",snapshot),snapshot=>{
            if(_login.ActiveAccountId?.ToString()!=snapshot.AccountId)return;
            var notification=_insights.AddNotification(_login.ActiveAccountId,"server-slot","На сервере появилось место",$"{snapshot.Name} · {snapshot.Players}/{snapshot.Limit}. Подключитесь, пока место доступно.",address:snapshot.Address);
            SendEvent("notification.created",ToNotificationDto(notification));
        });
    }
    private void CleanupTransferredCache()
    {
        try
        {
            if(_cacheTransfer.PreviousDatabase() is not {} old)return;
            // New database integrity is established before touching the previous copy.
            foreach(var path in new[]{LauncherPaths.PathContentDb,LauncherPaths.PathOverrideAssetsDb})if(File.Exists(path))
            {using var c=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=path,Mode=SqliteOpenMode.ReadOnly,Pooling=false}.ToString());c.Open();if(c.ExecuteScalar<string>("PRAGMA quick_check")!="ok")throw new IOException("Проверка новой базы не прошла.");}
            _cacheWarnings=_cacheTransfer.CleanupPrevious(()=>ManagedStorage.HasRunningClients(old));
        }
        catch(Exception e)when(e is IOException or SqliteException or UnauthorizedAccessException or JsonException)
        {_cacheWarnings=new[]{"Старая копия кэша сохранена: не удалось завершить проверку."};Log.Warning("Previous cache cleanup deferred");}
    }
    private async Task<object> MoveCacheAsync(JsonElement parameters)
    {
        if(_cacheLease!=null)throw new InvalidOperationException("Перенос уже выполняется или ожидает перезапуска.");
        _cacheLease=_maintenanceGate.Clean();
        try
        {
            if(_storage.Scan().BlockedReason is {} blocked)throw new InvalidOperationException(blocked);
            _cacheCancellation=CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
            await _overrideAssets.SuspendForMaintenanceAsync();
            SqliteConnection.ClearAllPools();
            foreach(var path in new[]{LauncherPaths.PathContentDb,LauncherPaths.PathOverrideAssetsDb})if(File.Exists(path))
            {using var c=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=path,Mode=SqliteOpenMode.ReadWrite,Pooling=false}.ToString());c.Open();var checkpoint=c.QuerySingle<(int Busy,int Frames,int Checkpointed)>("PRAGMA wal_checkpoint(TRUNCATE)");Log.Debug("Cache checkpoint {Database}: {Busy}/{Frames}/{Checkpointed}",Path.GetFileName(path),checkpoint.Busy,checkpoint.Frames,checkpoint.Checkpointed);if(checkpoint.Busy!=0)throw new InvalidOperationException("Кэш используется другим процессом. Закройте игру и повторите перенос.");}
            SqliteConnection.ClearAllPools();
            return await Task.Run(async()=>await _cacheTransfer.MoveAsync(RequiredString(parameters,"folder"),next=>{_cacheState=next;SendEvent("cache.progress",next);},_cacheCancellation.Token),_cacheCancellation.Token);
        }
        catch(OperationCanceledException){_cacheState=new("cancelled",0,0,null,"Перенос отменён. Исходные файлы сохранены.");SendEvent("cache.progress",_cacheState);return _cacheState;}
        catch(Exception){_cacheState=new("error",0,0,null,"Перенос не завершён. Исходные файлы сохранены.");SendEvent("cache.progress",_cacheState);throw;}
        finally{_cacheCancellation?.Dispose();_cacheCancellation=null;if(_cacheState.Stage!="ready"){_cacheLease?.Dispose();_cacheLease=null;_overrideAssets.ResumeAfterMaintenance();}}
    }
    private object CancelCache(){_cacheCancellation?.Cancel();return new{cancelled=_cacheCancellation!=null};}
    private object AddReplay(JsonElement p){var account=RequireActiveAccountForNotes();if(TryGetProperty(p,"expectedAccountId",out var expected)&&expected.GetString()!=account.ToString())throw new InvalidOperationException("Аккаунт изменился. Добавьте файл заново.");return _replays.Add(account.ToString(),RequiredString(p,"path"));}
    private object UpdateReplay(JsonElement p){_replays.Update(RequireActiveAccountForNotes().ToString(),RequiredString(p,"id"),RequiredString(p,"name"),OptionalString(p,"notes")??"",p.GetProperty("watched").GetBoolean());return new{ok=true};}
    private object RemoveReplay(JsonElement p){_replays.Remove(RequireActiveAccountForNotes().ToString(),RequiredString(p,"id"));return new{ok=true};}
    private object PlayReplay(JsonElement p){var path=_replays.Resolve(RequireActiveAccountForNotes().ToString(),RequiredString(p,"id"));return StartContentBundle(JsonSerializer.SerializeToElement(new{path}));}
    private PersonalData GetPersonalData(Guid account)=>new(
        _data.FavoriteServers.Items.Where(f=>PersonalData.NormalizeAddress(f.Address)!=null).Select(f=>new PersonalServer(PersonalData.NormalizeAddress(f.Address)!,string.IsNullOrWhiteSpace(f.Name)?"Сервер":f.Name.Trim()[..Math.Min(f.Name.Trim().Length,120)])).GroupBy(f=>f.Address).Select(g=>g.Last()).ToArray(),
        _insights.ListProfiles(account).Select(p=>new PersonalServer(p.Address,p.Name)).ToArray(),
        _serverNotes.List(account).Select(n=>new PersonalNote(n.Address,n.Text)).ToArray());
    private object PersonalSnapshot(){var account=RequireActiveAccountForNotes();return new{accountId=account,data=GetPersonalData(account)};}
    private async Task<object> ApplyPersonalAsync(JsonElement p)
    {
        var account=RequireActiveAccountForNotes();if(RequiredGuid(p,"expectedAccountId")!=account)throw new InvalidOperationException("Аккаунт изменился. Откройте предпросмотр заново.");
        var data=PersonalData.Parse(p.GetProperty("data").GetRawText());var sections=p.GetProperty("sections").EnumerateArray().Select(v=>v.GetString()).ToArray();
        if(sections.Any(s=>s is not("favorites" or "profiles" or "notes")))throw new InvalidOperationException("Неизвестный раздел архива.");
        var backup=Path.Combine(LauncherPaths.DirUserData,"backups","personal");Directory.CreateDirectory(backup);File.WriteAllText(Path.Combine(backup,$"{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}.json"),JsonSerializer.Serialize(GetPersonalData(account),JsonOptions));
        var previousFavorites=_data.FavoriteServers.Items.ToArray();
        try
        {
            if(sections.Contains("favorites"))foreach(var item in data.Favorites){foreach(var old in _data.FavoriteServers.Items.Where(f=>PersonalData.NormalizeAddress(f.Address)==PersonalData.NormalizeAddress(item.Address)).ToArray())_data.RemoveFavoriteServer(old);_data.AddFavoriteServer(new FavoriteServer(item.Name,PersonalData.NormalizeAddress(item.Address)!));}
            await _data.CommitConfigAsync();
        }
        catch { _data.RestoreFavoriteCache(previousFavorites);throw; }
        if(sections.Contains("profiles"))foreach(var item in data.Profiles)_insights.CreateProfile(account,item.Name,item.Address);
        if(sections.Contains("notes"))foreach(var item in data.Notes)_serverNotes.Upsert(account,item.Address,item.Text);
        SendEvent("auth.changed",new{accounts=GetAccounts(),activeAccount=GetAccountDto(_login.ActiveAccount),favorites=GetFavorites()});SendEvent("launchProfiles.updated",new{accountId=account,profiles=ListLaunchProfiles()});
        return new{ok=true};
    }
    private object StartSeatWatch(JsonElement p)
    {
        var account=RequireActiveAccountForNotes();_seatCancellation?.Cancel();_seatCancellation=CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);_seatWatch.Start(account.ToString(),RequiredString(p,"address"),OptionalString(p,"name")??"Сервер");
        _seatLoop=RunSeatWatchAsync(_seatCancellation);return _seatWatch.Snapshot;
    }
    private async Task RunSeatWatchAsync(CancellationTokenSource cancellation)
    {
        var cancel=cancellation.Token;
        try{while(!cancel.IsCancellationRequested&&_seatWatch.Active){await _seatWatch.PollAsync(cancel);if(_seatWatch.Active)await Task.Delay(TimeSpan.FromSeconds(30),cancel);}}
        catch(OperationCanceledException)when(cancel.IsCancellationRequested){}
        catch(Exception error){Log.Warning(error,"Server slot watch stopped");_seatWatch.Stop();SendEvent("app.error",new{code="SEAT_WATCH_FAILED",message="Ожидание места остановлено. Повторите запрос."});}
        finally{if(ReferenceEquals(_seatCancellation,cancellation))_seatCancellation=null;cancellation.Dispose();}
    }
    private object StopSeatWatch(){_seatCancellation?.Cancel();_seatWatch.Stop();return _seatWatch.Snapshot;}
}
