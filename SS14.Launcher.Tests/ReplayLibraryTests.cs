#nullable enable
using System;
using System.IO;
using System.IO.Compression;
using NUnit.Framework;
using SS14.Launcher.Models.Replays;

namespace SS14.Launcher.Tests;
[TestFixture] public sealed class ReplayLibraryTests
{
    private string _root=null!;
    [SetUp] public void Setup(){_root=Path.Combine(Path.GetTempPath(),"mados-replays",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(_root);}
    [TearDown] public void Cleanup(){Directory.Delete(_root,true);}
    private string Zip(string json){var path=Path.Combine(_root,Guid.NewGuid()+".zip");using var zip=ZipFile.Open(path,ZipArchiveMode.Create);using var writer=new StreamWriter(zip.CreateEntry("rt_content_bundle.json").Open());writer.Write(json);return path;}
    [Test] public void IndexesMetadataWithoutExtractingAndScopesEditsToAccount(){var store=new ReplayLibrary(Path.Combine(_root,"library.db"));var a=Guid.NewGuid().ToString();var b=Guid.NewGuid().ToString();var file=Zip("{\"engine_version\":\"1.2.3\",\"base_build\":{\"fork_id\":\"Station\",\"version\":\"abc\"}}");var item=store.Add(a,file);Assert.That(item.EngineVersion,Is.EqualTo("1.2.3"));Assert.That(store.List(b),Is.Empty);store.Update(a,item.Id,"Смена","Заметка",true);Assert.That(store.List(a)[0].Watched,Is.True);Assert.Throws<InvalidOperationException>(()=>store.Update(b,item.Id,"x","",false));Assert.That(store.Resolve(a,item.Id),Is.EqualTo(file));store.Remove(a,item.Id);Assert.That(File.Exists(file),Is.True);}
    [Test] public void RejectsMalformedOrChangedBundle(){var store=new ReplayLibrary(Path.Combine(_root,"library.db"));Assert.Throws<InvalidDataException>(()=>store.Add("a",Zip("{}")));var file=Zip("{\"engine_version\":\"1.2.3\"}");var item=store.Add("a",file);File.WriteAllText(file,"changed");Assert.Throws<InvalidDataException>(()=>store.Resolve("a",item.Id));}
    [Test] public void ReportsMissingFileAndRejectsLargeMetadata(){var store=new ReplayLibrary(Path.Combine(_root,"library.db"));var file=Zip("{\"engine_version\":\"1.2.3\"}");var item=store.Add("a",file);File.Delete(file);Assert.That(store.List("a")[0].Available,Is.False);Assert.Throws<FileNotFoundException>(()=>store.Resolve("a",item.Id));Assert.Throws<InvalidDataException>(()=>store.Add("a",Zip(new string(' ',65537))));}
}
