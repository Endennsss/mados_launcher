using System;
using System.IO;
using System.Linq;
using NUnit.Framework;
using SS14.Launcher.Worker;

#nullable enable

namespace SS14.Launcher.Tests;

[TestFixture]
public sealed class ServerNotesStoreTests
{
    [Test]
    public void UpsertCreatesAndUpdatesNoteForAccount()
    {
        using var database = new TemporaryDatabase();
        var account = Guid.NewGuid();
        var store = new ServerNotesStore(database.Path);

        var created = store.Upsert(account, "ss14://station.example:1212", "  Bring tools  ")!;
        var updated = store.Upsert(account, "SS14://STATION.EXAMPLE:1212/", "Use the west airlock")!;

        Assert.That(created.Address, Is.EqualTo("ss14://station.example"));
        Assert.That(updated.Address, Is.EqualTo(created.Address));
        Assert.That(updated.Text, Is.EqualTo("Use the west airlock"));
        Assert.That(updated.UpdatedAtUtc, Is.GreaterThanOrEqualTo(created.UpdatedAtUtc));
        Assert.That(store.List(account), Has.Count.EqualTo(1));
    }

    [Test]
    public void EmptyTextRemovesExistingNote()
    {
        using var database = new TemporaryDatabase();
        var account = Guid.NewGuid();
        var store = new ServerNotesStore(database.Path);
        store.Upsert(account, "ss14://station.example:1212", "Remember cargo");

        var removed = store.Upsert(account, "ss14://station.example:1212", " \r\n ");

        Assert.That(removed, Is.Null);
        Assert.That(store.List(account), Is.Empty);
    }

    [Test]
    public void NotesAreIsolatedByAccountAndAddressCredentialsAreNotStored()
    {
        using var database = new TemporaryDatabase();
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        var store = new ServerNotesStore(database.Path);

        var note = store.Upsert(first, "ss14://user:secret@Station.Example:1212/?token=hidden#round", "Private note")!;

        Assert.That(note.Address, Is.EqualTo("ss14://station.example"));
        Assert.That(note.Address, Does.Not.Contain("secret"));
        Assert.That(note.Address, Does.Not.Contain("token"));
        Assert.That(store.List(first).Select(item => item.Text), Is.EqualTo(new[] { "Private note" }));
        Assert.That(store.List(second), Is.Empty);
        Assert.That(store.Remove(second, note.Address), Is.False);
        Assert.That(store.List(first), Has.Count.EqualTo(1));
    }

    [Test]
    public void RemoveOnlyDeletesTheSelectedAccountAndServer()
    {
        using var database = new TemporaryDatabase();
        var account = Guid.NewGuid();
        var otherAccount = Guid.NewGuid();
        var store = new ServerNotesStore(database.Path);
        store.Upsert(account, "ss14://one.example:1212", "One");
        store.Upsert(account, "ss14://two.example:1212", "Two");
        store.Upsert(otherAccount, "ss14://one.example:1212", "Other");

        Assert.That(store.Remove(account, "ss14://one.example:1212/"), Is.True);
        Assert.That(store.List(account).Single().Text, Is.EqualTo("Two"));
        Assert.That(store.List(otherAccount).Single().Text, Is.EqualTo("Other"));
    }

    [Test]
    public void RejectsMissingAccountAddressAndOversizedText()
    {
        using var database = new TemporaryDatabase();
        var store = new ServerNotesStore(database.Path);

        Assert.That(() => store.List(Guid.Empty), Throws.TypeOf<ArgumentException>());
        Assert.That(() => store.Upsert(Guid.Empty, "ss14://station.example", "note"), Throws.TypeOf<ArgumentException>());
        Assert.That(() => store.Upsert(Guid.NewGuid(), "https://not-a-server", "note"), Throws.TypeOf<ArgumentException>());
        Assert.That(() => store.Upsert(Guid.NewGuid(), "ss14://station.example", new string('x', ServerNotesStore.MaxTextLength + 1)), Throws.TypeOf<ArgumentException>());
    }

    private sealed class TemporaryDatabase : IDisposable
    {
        private readonly string _directory = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "mados-server-notes-tests", Guid.NewGuid().ToString("N"));
        public string Path => System.IO.Path.Combine(_directory, "server-notes.db");

        public TemporaryDatabase() => Directory.CreateDirectory(_directory);

        public void Dispose()
        {
            try { Directory.Delete(_directory, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
