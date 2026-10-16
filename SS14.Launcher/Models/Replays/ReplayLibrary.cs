using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text.Json;
using Dapper;
using Microsoft.Data.Sqlite;
using SS14.Launcher.Models.Maintenance;

namespace SS14.Launcher.Models.Replays;

public sealed record ReplayItem(string Id,string Name,string Notes,bool Watched,string FileName,long Bytes,string EngineVersion,string? Fork,string? Build,string AddedAt,bool Available);
public sealed class ReplayLibrary
{
    private readonly string _db;
    private sealed class Row{public string Id{get;set;}="";public string Path{get;set;}="";public string Name{get;set;}="";public string Notes{get;set;}="";public bool Watched{get;set;}public long Bytes{get;set;}public long Modified{get;set;}public string EngineVersion{get;set;}="";public string? Fork{get;set;}public string? Build{get;set;}public string AddedAt{get;set;}="";}
    public ReplayLibrary(string database){_db=database;Directory.CreateDirectory(Path.GetDirectoryName(database)!);using var c=Open();c.Execute("CREATE TABLE IF NOT EXISTS Replay(Id TEXT PRIMARY KEY,AccountId TEXT NOT NULL,Path TEXT NOT NULL,Name TEXT NOT NULL,Notes TEXT NOT NULL,Watched INTEGER NOT NULL,Bytes INTEGER NOT NULL,Modified INTEGER NOT NULL,EngineVersion TEXT NOT NULL,Fork TEXT,Build TEXT,AddedAt TEXT NOT NULL,UNIQUE(AccountId,Path));");}
    private SqliteConnection Open(){var c=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=_db,Pooling=false}.ToString());c.Open();return c;}
    private static ReplayItem Dto(Row r)=>new(r.Id,r.Name,r.Notes,r.Watched,System.IO.Path.GetFileName(r.Path),r.Bytes,r.EngineVersion,r.Fork,r.Build,r.AddedAt,File.Exists(r.Path));
    public ReplayItem[] List(string account){using var c=Open();return c.Query<Row>("SELECT * FROM Replay WHERE AccountId=@account ORDER BY AddedAt DESC",new{account}).Select(Dto).ToArray();}
    public ReplayItem Add(string account,string path)
    {
        path=Path.GetFullPath(path);var metadata=Inspect(path);var file=new FileInfo(path);using var c=Open();
        var row=new Row{Id=Guid.NewGuid().ToString("N"),Path=path,Name=Path.GetFileNameWithoutExtension(path),Bytes=file.Length,Modified=file.LastWriteTimeUtc.Ticks,EngineVersion=metadata.Engine,Fork=metadata.Fork,Build=metadata.Build,AddedAt=DateTimeOffset.UtcNow.ToString("O")};
        c.Execute("INSERT INTO Replay(Id,AccountId,Path,Name,Notes,Watched,Bytes,Modified,EngineVersion,Fork,Build,AddedAt) VALUES(@Id,@account,@Path,@Name,'',0,@Bytes,@Modified,@EngineVersion,@Fork,@Build,@AddedAt) ON CONFLICT(AccountId,Path) DO UPDATE SET Bytes=excluded.Bytes,Modified=excluded.Modified,EngineVersion=excluded.EngineVersion,Fork=excluded.Fork,Build=excluded.Build",new{row.Id,account,row.Path,row.Name,row.Bytes,row.Modified,row.EngineVersion,row.Fork,row.Build,row.AddedAt});
        return Dto(c.QuerySingle<Row>("SELECT * FROM Replay WHERE AccountId=@account AND Path=@path",new{account,path}));
    }
    public void Update(string account,string id,string name,string notes,bool watched)
    {
        name=name.Trim();if(name.Length is <1 or >120||notes.Length>4000)throw new InvalidOperationException("Название: 1–120 символов, заметка: до 4000.");using var c=Open();if(c.Execute("UPDATE Replay SET Name=@name,Notes=@notes,Watched=@watched WHERE AccountId=@account AND Id=@id",new{account,id,name,notes,watched})!=1)throw new InvalidOperationException("Запись не найдена.");
    }
    public void Remove(string account,string id){using var c=Open();c.Execute("DELETE FROM Replay WHERE AccountId=@account AND Id=@id",new{account,id});}
    public string Resolve(string account,string id)
    {
        using var c=Open();var row=c.QuerySingleOrDefault<Row>("SELECT * FROM Replay WHERE AccountId=@account AND Id=@id",new{account,id})??throw new InvalidOperationException("Запись не найдена.");var file=new FileInfo(row.Path);if(!file.Exists)throw new FileNotFoundException("ZIP перемещён или удалён. Добавьте его заново.");
        if(file.Length!=row.Bytes||file.LastWriteTimeUtc.Ticks!=row.Modified)throw new InvalidDataException("ZIP изменился. Добавьте его заново для проверки.");Inspect(row.Path);return row.Path;
    }
    private static (string Engine,string? Fork,string? Build) Inspect(string path)
    {
        if(!path.EndsWith(".zip",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Выберите ZIP реплея или контент-бандла.");ManagedStorage.EnsureSafe(path,Path.GetDirectoryName(path)!);
        using var zip=ZipFile.OpenRead(path);var metadata=zip.GetEntry("rt_content_bundle.json");if(metadata==null||metadata.Length>65536)throw new InvalidDataException("ZIP не содержит корректных метаданных SS14.");
        using var stream=metadata.Open();using var buffer=new MemoryStream();var bytes=new byte[4096];int read;while((read=stream.Read(bytes))>0){if(buffer.Length+read>65536)throw new InvalidDataException("Метаданные слишком большие.");buffer.Write(bytes,0,read);}
        try{using var json=JsonDocument.Parse(buffer.ToArray());var root=json.RootElement;if(root.ValueKind!=JsonValueKind.Object||!root.TryGetProperty("engine_version",out var version)||version.ValueKind!=JsonValueKind.String||!Version.TryParse(version.GetString(),out _))throw new InvalidDataException("Не указана версия движка SS14.");string? fork=null,build=null;if(root.TryGetProperty("base_build",out var b)&&b.ValueKind==JsonValueKind.Object){if(b.TryGetProperty("fork_id",out var f)&&f.ValueKind==JsonValueKind.String)fork=f.GetString();if(b.TryGetProperty("version",out var v)&&v.ValueKind==JsonValueKind.String)build=v.GetString();}return(version.GetString()!,Clean(fork),Clean(build));}
        catch(JsonException){throw new InvalidDataException("Метаданные ZIP повреждены.");}
    }
    private static string? Clean(string? value)=>value==null?null:new string(value.Where(c=>!char.IsControl(c)).Take(120).ToArray());
}
