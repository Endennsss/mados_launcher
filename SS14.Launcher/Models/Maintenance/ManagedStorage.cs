using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Dapper;
using Microsoft.Data.Sqlite;

namespace SS14.Launcher.Models.Maintenance;

public sealed record StorageCategory(string Id, string Name, long Bytes, string Description);
public sealed record StorageItem(string Id, string Category, string Name, long Bytes, string? LastUsed, bool CanDelete, string? ProtectedReason);
public sealed record StorageScan(string CapturedAt, long TotalBytes, long? FreeBytes, string? BlockedReason, StorageCategory[] Categories, StorageItem[] Items, string[] Warnings);
public sealed record StoragePreview(string PlanId, string ExpiresAt, long EstimatedBytes, StorageItem[] Items);
public sealed record StorageCleanResult(int RemovedItems, long FreedBytes, string[] Warnings);

/// <summary>Inventories owned storage; cleanup only accepts IDs from a short-lived, revalidated preview.</summary>
public sealed class ManagedStorage
{
    private readonly string _db, _engines, _modules, _logs, _servers;
    private readonly Func<bool> _busy;
    private readonly Func<DateTimeOffset> _clock;
    private readonly object _gate = new();
    private Plan? _plan;
    private sealed record Plan(StoragePreview Preview, Dictionary<string,string> Fingerprints);
    private sealed record Entry(StorageItem Item, string Fingerprint, string? Path = null);
    private sealed class VersionRow { public long Id {get;set;} public string? ForkId {get;set;} public string? ForkVersion {get;set;} public string? LastUsed {get;set;} public long Bytes {get;set;} public int Latest {get;set;} }

    public ManagedStorage(string database, string engines, string modules, string logs, string servers, Func<bool> busy, Func<DateTimeOffset>? clock = null)
    { _db=Path.GetFullPath(database);_engines=Path.GetFullPath(engines);_modules=Path.GetFullPath(modules);_logs=Path.GetFullPath(logs);_servers=Path.GetFullPath(servers);_busy=busy;_clock=clock??(()=>DateTimeOffset.UtcNow); }

    public StorageScan Scan()
    {
        lock(_gate)
        {
            var warnings=new List<string>();
            var entries=Entries(warnings);
            string? blocked=_busy()?"Дождитесь завершения игры, подключения или установки.":null;
            if (File.Exists(_db)) { using var c=Open(); if(Running(c).Count>0)blocked="Игра использует файлы. Закройте её перед очисткой."; }
            long Size(string path) => Measure(path,warnings);
            var categories=new[]{
                new StorageCategory("content","Игровые сборки",Size(_db)+Size(_db+"-wal")+Size(_db+"-shm"),"Общий кэш файлов; одинаковые файлы хранятся один раз."),
                new StorageCategory("engines","Движки и модули",Size(_engines)+Size(_modules),"Компоненты запуска. Обновляются при подключении к игре."),
                new StorageCategory("logs","Журналы",Size(_logs),"Можно удалить закрытые журналы старше 7 дней."),
                new StorageCategory("localServers","Локальные серверы",Size(_servers),"Сборки, миры и резервные копии. Защищены от общей очистки.")};
            return new(_clock().ToString("O"),categories.Sum(c=>c.Bytes),FreeSpace(Path.GetDirectoryName(_db)!),blocked,categories,entries.Select(e=>e.Item).ToArray(),warnings.Distinct().ToArray());
        }
    }

    public StoragePreview Preview(string[] ids)
    {
        lock(_gate)
        {
            EnsureIdle();var chosen=Select(ids);
            long estimate=chosen.Where(e=>e.Path!=null).Sum(e=>e.Item.Bytes);
            if(chosen.Any(e=>e.Path==null)) { using var c=Open(); estimate+=Reclaimable(c,ContentIds(chosen)); }
            var preview=new StoragePreview(Guid.NewGuid().ToString("N"),_clock().AddMinutes(5).ToString("O"),estimate,chosen.Select(e=>e.Item).ToArray());
            _plan=new(preview,chosen.ToDictionary(e=>e.Item.Id,e=>e.Fingerprint));return preview;
        }
    }

    public StorageCleanResult Clean(string planId)
    {
        lock(_gate)
        {
            var plan=_plan;_plan=null;
            if(plan==null||plan.Preview.PlanId!=planId||DateTimeOffset.Parse(plan.Preview.ExpiresAt)<=_clock())throw new InvalidOperationException("Предпросмотр устарел. Рассчитайте очистку заново.");
            EnsureIdle();var entries=Select(plan.Fingerprints.Keys.ToArray());
            if(entries.Any(e=>plan.Fingerprints[e.Item.Id]!=e.Fingerprint))throw new InvalidOperationException("Файлы изменились. Рассчитайте очистку заново.");
            var warnings=new List<string>();var removed=0;long freed=0;
            var versionIds=ContentIds(entries);
            if(versionIds.Length>0)
            {
                var before=DbSize();using(var c=Open())
                {
                    using(var tx=c.BeginTransaction())
                    {
                        if(Running(c).Count>0)throw new InvalidOperationException("Игра использует файлы. Закройте её перед очисткой.");
                        // A launcher may have updated last-used timestamps since the preview/recheck.
                        var current=ContentEntries(c);
                        if(entries.Where(e=>e.Path==null).Any(e=>!current.Any(n=>n.Item.Id==e.Item.Id&&n.Item.CanDelete&&n.Fingerprint==e.Fingerprint)))throw new InvalidOperationException("Список сборок изменился. Обновите расчёт.");
                        c.Execute("DELETE FROM RunningClient"); // All entries were verified dead while holding the write lock.
                        c.Execute("CREATE TEMP TABLE CleanupContentIds AS SELECT DISTINCT ContentId FROM ContentManifest WHERE VersionId IN @Ids",new{Ids=versionIds});
                        removed+=c.Execute("DELETE FROM ContentVersion WHERE Id IN @Ids",new{Ids=versionIds});
                        c.Execute("DELETE FROM Content WHERE Id IN(SELECT ContentId FROM CleanupContentIds) AND NOT EXISTS(SELECT 1 FROM ContentManifest m WHERE m.ContentId=Content.Id) AND NOT EXISTS(SELECT 1 FROM InterruptedDownloadContent i WHERE i.ContentId=Content.Id)");
                        tx.Commit();
                    }
                    try { c.Execute("VACUUM");c.Execute("PRAGMA wal_checkpoint(TRUNCATE)"); }
                    catch(SqliteException) { warnings.Add("Сборки удалены, но сжатие базы не завершено. Часть места пока остаётся внутри кэша."); }
                }
                freed+=Math.Max(0,before-DbSize());
            }
            foreach(var entry in entries.Where(e=>e.Path!=null))
            {
                try
                {
                    EnsureSafe(entry.Path!,_logs);
                    if(LogEntry(entry.Path!)?.Fingerprint!=entry.Fingerprint){warnings.Add("Изменённый журнал пропущен.");continue;}
                    File.Delete(entry.Path!);removed++;freed+=entry.Item.Bytes;
                }
                catch(IOException){warnings.Add("Один из журналов занят и не удалён.");}
                catch(UnauthorizedAccessException){warnings.Add("Нет доступа к одному из журналов; он не удалён.");}
            }
            return new(removed,freed,warnings.Distinct().ToArray());
        }
    }

    private long DbSize()=> new[]{_db,_db+"-wal",_db+"-shm"}.Sum(p=>File.Exists(p)?new FileInfo(p).Length:0);
    private void EnsureIdle()
    {
        if(_busy())throw new InvalidOperationException("Очистка недоступна во время игры, подключения или установки.");
        if(File.Exists(_db)){using var c=Open();if(Running(c).Count>0)throw new InvalidOperationException("Игра использует файлы. Закройте её перед очисткой.");}
    }
    private Entry[] Select(string[] ids)
    {
        if(ids.Length is 0 or >500||ids.Distinct().Count()!=ids.Length)throw new InvalidOperationException("Выберите от 1 до 500 разных элементов.");
        var all=Entries(new List<string>()).ToDictionary(e=>e.Item.Id);
        return ids.Select(id=>all.TryGetValue(id,out var e)&&e.Item.CanDelete?e:throw new InvalidOperationException("Выбранный элемент защищён или уже изменился. Обновите список.")).ToArray();
    }
    private Entry[] Entries(List<string> warnings)
    {
        var list=new List<Entry>();
        if(File.Exists(_db)){using var c=Open();list.AddRange(ContentEntries(c));}
        if(Directory.Exists(_logs))
        {
            EnsureSafe(_logs,_logs);
            foreach(var file in Directory.EnumerateFiles(_logs,"*.log",SearchOption.TopDirectoryOnly))
            {
                try{var entry=LogEntry(file);if(entry!=null)list.Add(entry);}
                catch(Exception e) when(e is IOException or UnauthorizedAccessException){warnings.Add("Часть журналов недоступна или является ссылкой.");}
            }
        }
        return list.ToArray();
    }
    private List<Entry> ContentEntries(SqliteConnection c)
    {
        var rows=c.Query<VersionRow>(@"SELECT v.Id,v.ForkId,v.ForkVersion,v.LastUsed,
ROW_NUMBER() OVER(PARTITION BY COALESCE(ForkId,'') ORDER BY LastUsed DESC,v.Id DESC) AS Latest,
COALESCE((SELECT SUM(length(Data)) FROM Content WHERE Id IN(SELECT ContentId FROM ContentManifest WHERE VersionId=v.Id)),0) AS Bytes FROM ContentVersion v").ToArray();
        return rows.Select(v=>new Entry(new StorageItem("content:"+v.Id,"content",Label(v.ForkId)+" · "+Label(v.ForkVersion),v.Bytes,v.LastUsed,v.Latest!=1,v.Latest==1?"Последняя использованная версия этой сборки":null),$"{v.Id}|{v.LastUsed}|{v.Bytes}|{v.ForkId}|{v.ForkVersion}")).ToList();
    }
    private Entry? LogEntry(string path)
    {
        EnsureSafe(path,_logs);var file=new FileInfo(path);if(!file.Exists)return null;
        var id="log:"+Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(file.Name)));
        var old=file.LastWriteTimeUtc<_clock().AddDays(-7).UtcDateTime;
        return new(new(id,"logs",file.Name,file.Length,file.LastWriteTimeUtc.ToString("O"),old,old?null:"Журнал за последние 7 дней"),$"{file.Length}|{file.LastWriteTimeUtc.Ticks}",file.FullName);
    }
    private static string Label(string? value)=>string.IsNullOrWhiteSpace(value)?"Без названия":new string(value.Where(c=>!char.IsControl(c)).Take(100).ToArray());
    private static long[] ContentIds(IEnumerable<Entry> entries)=>entries.Where(e=>e.Item.Category=="content").Select(e=>long.Parse(e.Item.Id[8..])).ToArray();
    private static long Reclaimable(SqliteConnection c,long[] ids)=>c.ExecuteScalar<long>(@"SELECT COALESCE(SUM(length(Data)),0) FROM Content WHERE Id IN(SELECT ContentId FROM ContentManifest WHERE VersionId IN @Ids)
AND NOT EXISTS(SELECT 1 FROM ContentManifest m WHERE m.ContentId=Content.Id AND m.VersionId NOT IN @Ids)
AND NOT EXISTS(SELECT 1 FROM InterruptedDownloadContent i WHERE i.ContentId=Content.Id)",new{Ids=ids});
    private SqliteConnection Open()
    {
        EnsureSafe(_db,Path.GetDirectoryName(_db)!);EnsureSafe(_db+"-wal",Path.GetDirectoryName(_db)!);EnsureSafe(_db+"-shm",Path.GetDirectoryName(_db)!);
        var c=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=_db,Mode=SqliteOpenMode.ReadWrite,Pooling=false,ForeignKeys=true,DefaultTimeout=5}.ToString());c.Open();return c;
    }
    public static bool HasRunningClients(string database)
    {
        if(!File.Exists(database))return false;
        using var c=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=database,Mode=SqliteOpenMode.ReadOnly,Pooling=false}.ToString());c.Open();return Running(c).Count>0;
    }
    private static List<long> Running(SqliteConnection c)
    {
        var result=new List<long>();
        foreach(var row in c.Query<(int Pid,string Module,long Version)>("SELECT ProcessId,MainModule,UsedVersion FROM RunningClient"))
        {
            try { using var p=Process.GetProcessById(row.Pid);if(!p.HasExited){var module=p.MainModule?.FileName;if(module==null||string.Equals(module,row.Module,OperatingSystem.IsWindows()?StringComparison.OrdinalIgnoreCase:StringComparison.Ordinal))result.Add(row.Version);} }
            catch(ArgumentException) { }
            catch(Exception e) when(e is System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException) { result.Add(row.Version); }
        }
        return result;
    }
    public static void EnsureSafe(string path,string root)
    {
        var full=Path.GetFullPath(path);var parent=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        var comparison=OperatingSystem.IsWindows()?StringComparison.OrdinalIgnoreCase:StringComparison.Ordinal;
        if(!full.Equals(parent,comparison)&&!full.StartsWith(parent+Path.DirectorySeparatorChar,comparison))throw new IOException("Путь находится вне управляемого каталога.");
        for(var current=full;!string.IsNullOrEmpty(current);current=Path.GetDirectoryName(current))
            if((File.Exists(current)||Directory.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new IOException("Ссылки на другие каталоги исключены из очистки.");
    }
    private static long Measure(string path,List<string> warnings)
    {
        try
        {
            EnsureSafe(path,path);if(File.Exists(path))return new FileInfo(path).Length;if(!Directory.Exists(path))return 0;
            long size=0;foreach(var entry in Directory.EnumerateFileSystemEntries(path))size+=Measure(entry,warnings);return size;
        }
        catch(Exception e) when(e is IOException or UnauthorizedAccessException){warnings.Add("Некоторые файлы недоступны или являются ссылками; размер может быть неполным.");return 0;}
    }
    public static long? FreeSpace(string path)
    {try{return new DriveInfo(Path.GetPathRoot(Path.GetFullPath(path))!).AvailableFreeSpace;}catch(Exception e)when(e is IOException or UnauthorizedAccessException or ArgumentException){return null;}}
}
