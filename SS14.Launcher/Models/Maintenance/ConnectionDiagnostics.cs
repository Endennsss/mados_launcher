using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SS14.Launcher.Models.ServerStatus;

namespace SS14.Launcher.Models.Maintenance;

public sealed record DiagnosticCheck(string Id,string Title,string Status,string Message,string? Action=null);
public sealed record DiagnosticReport(string Address,string CheckedAt,DiagnosticCheck[] Checks);

public sealed class ConnectionDiagnostics
{
    private readonly HttpClient _http;
    private readonly string _engines, _data;
    private readonly SemaphoreSlim _runGate=new(1,1);
    public ConnectionDiagnostics(HttpClient http,string engines,string data){_http=http;_engines=engines;_data=data;}
    public async Task<DiagnosticReport> RunAsync(string input,string accountState,CancellationToken cancel)
    {
        if(!await _runGate.WaitAsync(0,cancel))throw new InvalidOperationException("Предыдущая проверка ещё выполняется. Повторите через несколько секунд.");
        try{return await RunCoreAsync(input,accountState,cancel);}finally{_runGate.Release();}
    }
    private async Task<DiagnosticReport> RunCoreAsync(string input,string accountState,CancellationToken cancel)
    {
        if(input.Length>2048||PresenceAddress.Sanitize(input) is not {} address)throw new InvalidOperationException("Введите корректный адрес ss14:// или ss14s://.");
        // Only the sanitized address is used for probes and returned reports.
        var uri=UriHelper.ParseSs14Uri(address);var checks=new List<DiagnosticCheck>();
        checks.Add(accountState=="valid"?new("account","Аккаунт","passed","Локальная сессия активна. Допуск к конкретному серверу проверяется при подключении."):new("account","Аккаунт","warning",accountState=="expired"?"Сессия истекла. Войдите заново.":"Нет активной сессии. Сервер с обязательной авторизацией потребует вход.","login"));
        var watch=Stopwatch.StartNew();
        using(var status=await Probe(UriHelper.GetServerStatusAddress(uri),cancel))
        {
            checks.Add(status?.RootElement.TryGetProperty("players",out var players)==true&&players.ValueKind==JsonValueKind.Number
                ?new("server","Доступность сервера","passed",$"Сервер отвечает на /status · {watch.ElapsedMilliseconds} мс.")
                :new("server","Доступность сервера","failed","Не удалось получить статус. Сервер может быть недоступен, либо соединение блокируется сетью.","retry"));
        }
        using(var info=await Probe(UriHelper.GetServerInfoAddress(uri),cancel))
        {
            if(info?.RootElement.TryGetProperty("build",out var build)==true&&build.ValueKind==JsonValueKind.Object&&build.TryGetProperty("engine_version",out var version)&&version.ValueKind==JsonValueKind.String&&Version.TryParse(version.GetString(),out _))
            {
                checks.Add(new("build","Сведения о сборке","passed","Сервер передал версию движка для загрузки. Совместимость и подписи проверяются при запуске."));
                checks.Add(await CheckDownload(build,uri,cancel));
                var engine=Path.Combine(_engines,version.GetString()+".zip");
                if(!File.Exists(engine))checks.Add(new("engine","Файлы движка","info","Эта версия ещё не скачана. Обычное подключение загрузит её автоматически.","connect"));
                else
                {
                    try{ManagedStorage.EnsureSafe(engine,_engines);using var archive=ZipFile.OpenRead(engine);if(archive.Entries.Count==0)throw new InvalidDataException();checks.Add(new("engine","Файлы движка","passed","Архив установлен и читается. Полная проверка подписи выполняется игровым загрузчиком."));}
                    catch(Exception e)when(e is IOException or InvalidDataException or UnauthorizedAccessException){checks.Add(new("engine","Файлы движка","failed","Установленный архив недоступен или повреждён. Откройте журнал запуска для подробностей.","logs"));}
                }
            }
            else checks.Add(new("build","Сведения о сборке","failed","Сервер не передал корректные сведения о движке. Повторите проверку или сообщите администрации сервера.","retry"));
        }
        var free=ManagedStorage.FreeSpace(_data);
        checks.Add(free==null?new("disk","Место на диске","warning","Не удалось определить свободное место.","storage"):new("disk","Место на диске",free<1024L*1024*1024?"warning":"passed",$"Свободно {free.Value/(1024d*1024*1024):F1} ГБ. Точный размер загрузки определяется при подключении.",free<1024L*1024*1024?"storage":null));
        return new(address,DateTimeOffset.UtcNow.ToString("O"),checks.ToArray());
    }
    private async Task<DiagnosticCheck> CheckDownload(JsonElement build,Uri server,CancellationToken cancel)
    {
        var acz=build.TryGetProperty("acz",out var aczValue)&&aczValue.ValueKind==JsonValueKind.True;
        string? Field(string name)=>build.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.String?value.GetString():null;
        // Match Connector's self-hosted URL normalization and Updater's manifest preference.
        var api=UriHelper.GetServerApiAddress(server);
        var download=acz||string.IsNullOrEmpty(Field("download_url"))?new Uri(api,"client.zip").ToString():Field("download_url");
        var manifest=acz?new Uri(api,"manifest.txt").ToString():Field("manifest_url");
        var manifestDownload=acz?new Uri(api,"download").ToString():Field("manifest_download_url");
        var source=!string.IsNullOrEmpty(manifest)&&!string.IsNullOrEmpty(manifestDownload)&&!string.IsNullOrEmpty(Field("manifest_hash"))?manifest:download;
        Uri? target=null;
        Uri.TryCreate(source,UriKind.Absolute,out target);
        if(target==null||target.Scheme is not ("http" or "https")||target.UserInfo.Length>0||target.Query.Length>0||target.Fragment.Length>0)
            return new("download","Источник загрузки","info","Адрес требует параметров или авторизации. Его проверит обычное подключение.","connect");
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);timeout.CancelAfter(TimeSpan.FromSeconds(6));
        try
        {
            using var request=new HttpRequestMessage(HttpMethod.Head,target);using var response=await _http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,timeout.Token);
            if(response.IsSuccessStatusCode)return new("download","Источник загрузки","passed","Источник отвечает на HEAD-запрос. Сборка не скачивалась; содержимое будет проверено при подключении.");
            if((int)response.StatusCode is 405 or 501 or >=300 and <400)return new("download","Источник загрузки","info","Источник требует обычную загрузку или перенаправление. Проверка продолжится при подключении.","connect");
            return new("download","Источник загрузки","failed",$"Источник вернул HTTP {(int)response.StatusCode}. Попробуйте позже или сообщите администрации сервера.","retry");
        }
        catch(OperationCanceledException)when(!cancel.IsCancellationRequested){return new("download","Источник загрузки","failed","Источник загрузки не ответил вовремя.","retry");}
        catch(HttpRequestException){return new("download","Источник загрузки","failed","Не удалось связаться с источником загрузки.","retry");}
    }
    private async Task<JsonDocument?> Probe(Uri uri,CancellationToken cancel)
    {
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);timeout.CancelAfter(TimeSpan.FromSeconds(6));
        try
        {
            using var request=new HttpRequestMessage(HttpMethod.Get,uri);using var response=await _http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,timeout.Token);
            if(!response.IsSuccessStatusCode||response.Content.Headers.ContentLength>1024*1024)return null;
            await using var stream=await response.Content.ReadAsStreamAsync(timeout.Token);using var buffer=new MemoryStream();var bytes=new byte[8192];int read;
            while((read=await stream.ReadAsync(bytes,timeout.Token))>0){if(buffer.Length+read>1024*1024)return null;buffer.Write(bytes,0,read);}
            var document=JsonDocument.Parse(buffer.ToArray());if(document.RootElement.ValueKind==JsonValueKind.Object)return document;document.Dispose();return null;
        }
        catch(OperationCanceledException)when(!cancel.IsCancellationRequested){return null;}
        catch(Exception e)when(e is HttpRequestException or JsonException or IOException){return null;}
    }
}
