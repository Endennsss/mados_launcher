using NUnit.Framework;
using SS14.Launcher.Models.Personal;
namespace SS14.Launcher.Tests;
[TestFixture] public sealed class PersonalDataTests
{
 [Test] public void AcceptsOnlyPortableFieldsAndSanitizedAddresses(){var data=PersonalData.Parse("{\"favorites\":[{\"address\":\"ss14://station\",\"name\":\"Station\"}],\"profiles\":[],\"notes\":[]}");Assert.That(data.Favorites.Length,Is.EqualTo(1));Assert.Throws<System.Text.Json.JsonException>(()=>PersonalData.Parse("{\"favorites\":[],\"profiles\":[],\"notes\":[],\"token\":\"secret\"}"));Assert.Throws<System.InvalidOperationException>(()=>PersonalData.Parse("{\"favorites\":[{\"address\":\"ss14://user:pass@host/?token=x\",\"name\":\"x\"}],\"profiles\":[],\"notes\":[]}"));}
}
