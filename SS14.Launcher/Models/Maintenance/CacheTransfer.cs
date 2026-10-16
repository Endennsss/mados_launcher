using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace SS14.Launcher.Models.Maintenance;

public sealed record CacheTransferState(string Stage,long CompletedBytes,long TotalBytes,string? Destination,string? Message=null);

/// <summary>Copies only managed cache components and atomically changes next-start paths.</summary>
public sealed class CacheTransfer(string markerPath)
{
    private static readonly string[] Components={"engines","modules","content.db","override_assets.db"};
    private string Journal=>markerPath+".cache-transfer.json";
    private sealed record CopiedFile(string Component,string Relative,long Length,string Hash);
    private sealed record TransferJournal(string OldUser,string OldLocal,string Destination,CopiedFile[] Files);
    private (string User,string Local) Paths(){var node=JsonNode.Parse(File.ReadAllText(markerPath))!;return(Path.GetFullPath(node["CacheUser"]!.GetValue<string>()),Path.GetFullPath(node["CacheLocal"]!.GetValue<string>()));}
    public object Info(){var paths=Paths();return new{userPath=paths.User,localPath=paths.Local};}
    private static string Source(string user,string local,string component)=>Path.Combine(component is "engines" or "modules"?user:local,component);
    private static bool Within(string path,string root)=>Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar).Equals(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar),StringComparison.OrdinalIgnoreCase)||Path.GetFullPath(path).StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
    private static string FilePath(string root,string relative){var path=relative==""?root:Path.Combine(root,relative);ManagedStorage.EnsureSafe(path,root);return path;}
    private static IEnumerable<string> Files(string path){ManagedStorage.EnsureSafe(path,path);if(File.Exists(path)){yield return path;yield break;}if(!Directory.Exists(path))yield break;foreach(var entry in Directory.EnumerateFileSystemEntries(path))foreach(var file in Files(entry))yield return file;}
    private static string Hash(string path){using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);return Convert.ToHexString(SHA256.HashData(stream));}
    private static async Task<string> HashAsync(string path,CancellationToken cancel){await using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read,1024*1024,true);return Convert.ToHexString(await SHA256.HashDataAsync(stream,cancel));}
    private static void Atomic(string path,string text){var temp=path+".tmp";File.WriteAllText(temp,text);File.Move(temp,path,true);}

    public async Task<CacheTransferState> MoveAsync(string folder,Action<CacheTransferState> report,CancellationToken cancel)
    {
        cancel.ThrowIfCancellationRequested();var paths=Paths();folder=Path.GetFullPath(folder);ManagedStorage.EnsureSafe(folder,folder);
        if(Components.Any(c=>Within(folder,Source(paths.User,paths.Local,c))))throw new InvalidOperationException("Выберите папку вне текущего игрового кэша.");
        if(File.Exists(Journal))throw new InvalidOperationException("Предыдущий перенос ещё ожидает завершения. Перезапустите лаунчер.");
        var items=Components.SelectMany(c=>Files(Source(paths.User,paths.Local,c)).Select(p=>(Component:c,Path:p,Relative:c.EndsWith(".db")?"":Path.GetRelativePath(Source(paths.User,paths.Local,c),p),Length:new FileInfo(p).Length))).ToArray();
        var total=items.Sum(i=>i.Length);if(ManagedStorage.FreeSpace(folder) is {} free&&free<total+64*1024*1024)throw new InvalidOperationException("Недостаточно места для копирования и проверки кэша.");
        Directory.CreateDirectory(folder);var target=Path.Combine(folder,"Mados Cache-"+Guid.NewGuid().ToString("N")[..8]);Directory.CreateDirectory(target);
        var copied=new List<CopiedFile>();var committed=false;long done=0;var buffer=new byte[1024*1024];var progressClock=System.Diagnostics.Stopwatch.StartNew();
        void Progress(string stage){if(progressClock.ElapsedMilliseconds<150)return;report(new(stage,done,total,target));progressClock.Restart();}
        report(new("copying",0,total,target));
        try
        {
            foreach(var item in items)
            {
                cancel.ThrowIfCancellationRequested();ManagedStorage.EnsureSafe(item.Path,Source(paths.User,paths.Local,item.Component));
                var destination=FilePath(Path.Combine(target,item.Component),item.Relative);Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                await using(var input=new FileStream(item.Path,FileMode.Open,FileAccess.Read,FileShare.Read,buffer.Length,true))
                await using(var output=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.None,buffer.Length,true))
                {int read;while((read=await input.ReadAsync(buffer,cancel))>0){await output.WriteAsync(buffer.AsMemory(0,read),cancel);hash.AppendData(buffer,0,read);done+=read;Progress("copying");}await output.FlushAsync(cancel);}
                Progress("verifying");var digest=Convert.ToHexString(hash.GetHashAndReset());
                if(await HashAsync(destination,cancel)!=digest||await HashAsync(item.Path,cancel)!=digest)throw new IOException("Файлы изменились во время переноса. Исходный кэш сохранён.");
                copied.Add(new(item.Component,item.Relative,item.Length,digest));
            }
            cancel.ThrowIfCancellationRequested();
            // Write recovery information before switching. A crash before the switch leaves originals untouched.
            Atomic(Journal,JsonSerializer.Serialize(new TransferJournal(paths.User,paths.Local,target,copied.ToArray())));
            var marker=JsonNode.Parse(File.ReadAllText(markerPath))!;marker["CacheUser"]=target;marker["CacheLocal"]=target;
            Atomic(markerPath,marker.ToJsonString());committed=true;
            var result=new CacheTransferState("ready",done,total,target,"Перезапустите Mados. Старая копия будет удалена после проверки нового кэша.");report(result);return result;
        }
        finally
        {
            if(!committed)
            {
                // This random directory belongs exclusively to this attempt; validate before recursive cleanup.
                ManagedStorage.EnsureSafe(target,folder);
                if(Directory.Exists(target))Directory.Delete(target,true);
                if(File.Exists(Journal))File.Delete(Journal);
            }
        }
    }

    public string[] CleanupPrevious(Func<bool> originalInUse)
    {
        if(!File.Exists(Journal))return Array.Empty<string>();
        var transfer=JsonSerializer.Deserialize<TransferJournal>(File.ReadAllText(Journal))??throw new IOException("Неверный журнал переноса.");var current=Paths();
        if(current.User!=transfer.Destination||current.Local!=transfer.Destination){File.Delete(Journal);return new[]{"Незавершённый перенос отменён; исходные файлы сохранены."};}
        if(originalInUse())return new[]{"Старый кэш ещё используется. Его очистка отложена до следующего запуска."};
        var warnings=new List<string>();
        // Verify every new file before deleting even one original.
        foreach(var item in transfer.Files)
        {if(!Components.Contains(item.Component))throw new IOException("Неверный компонент кэша.");var next=FilePath(Path.Combine(transfer.Destination,item.Component),item.Relative);if(!File.Exists(next)||Hash(next)!=item.Hash){File.Move(Journal,Journal+".retained-"+Guid.NewGuid().ToString("N"));return new[]{"Новый кэш изменился после переноса. Старая копия сохранена: "+transfer.OldUser+"; "+transfer.OldLocal};}}
        foreach(var item in transfer.Files)
        {
            try{var old=FilePath(Source(transfer.OldUser,transfer.OldLocal,item.Component),item.Relative);if(!File.Exists(old))continue;if(Hash(old)!=item.Hash){warnings.Add("Изменённые файлы старого кэша сохранены.");continue;}File.Delete(old);}
            catch(Exception e)when(e is IOException or UnauthorizedAccessException){warnings.Add("Часть старого кэша занята или недоступна и сохранена.");}
        }
        File.Delete(Journal);return warnings.Distinct().ToArray();
    }
    public string? PreviousDatabase(){if(!File.Exists(Journal))return null;var journal=JsonSerializer.Deserialize<TransferJournal>(File.ReadAllText(Journal));return journal==null?null:Path.Combine(journal.OldLocal,"content.db");}
}
