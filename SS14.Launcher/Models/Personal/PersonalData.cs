using System;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SS14.Launcher.Models.Personal;
public sealed record PersonalServer(string Address,string Name);
public sealed record PersonalNote(string Address,string Text);
public sealed record PersonalData(PersonalServer[] Favorites,PersonalServer[] Profiles,PersonalNote[] Notes)
{
    public static PersonalData Parse(string json)
    {
        if(json.Length>4*1024*1024)throw new InvalidOperationException("Архив слишком большой.");
        var data=JsonSerializer.Deserialize<PersonalData>(json,new JsonSerializerOptions(JsonSerializerDefaults.Web){UnmappedMemberHandling=JsonUnmappedMemberHandling.Disallow})??throw new InvalidOperationException("Пустой архив.");
        if(data.Favorites==null||data.Profiles==null||data.Notes==null||data.Favorites.Length>2000||data.Profiles.Length>500||data.Notes.Length>2000)throw new InvalidOperationException("Неверный размер разделов архива.");
        foreach(var item in data.Favorites.Concat(data.Profiles)){if(item==null||string.IsNullOrWhiteSpace(item.Name)||item.Name.Length>120)throw new InvalidOperationException("Неверное имя сервера.");CheckAddress(item.Address);}
        foreach(var note in data.Notes){if(note==null||note.Text==null||note.Text.Length>4000)throw new InvalidOperationException("Неверная заметка.");CheckAddress(note.Address);}
        return new(data.Favorites.Select(i=>i with{Address=NormalizeAddress(i.Address)!}).GroupBy(i=>i.Address).Select(g=>g.Last()).ToArray(),data.Profiles.Select(i=>i with{Address=NormalizeAddress(i.Address)!}).GroupBy(i=>i.Address).Select(g=>g.Last()).ToArray(),data.Notes.Select(i=>i with{Address=NormalizeAddress(i.Address)!}).GroupBy(i=>i.Address).Select(g=>g.Last()).ToArray());
    }
    public static string? NormalizeAddress(string address){var safe=ServerStatus.PresenceAddress.Sanitize(address);if(safe==null)return null;var uri=new UriBuilder(safe);if((uri.Scheme=="ss14"&&uri.Port==1212)||(uri.Scheme=="ss14s"&&uri.Port==443))uri.Port=-1;return uri.Uri.AbsoluteUri.TrimEnd('/');}
    private static void CheckAddress(string address){if(address==null||address.Length>2048||!Uri.TryCreate(address,UriKind.Absolute,out var uri)||uri.Scheme is not("ss14" or "ss14s")||string.IsNullOrEmpty(uri.Host)||uri.UserInfo!=""||uri.Query!=""||uri.Fragment!="")throw new InvalidOperationException("Архив содержит адрес с параметрами или секретами.");}
}
