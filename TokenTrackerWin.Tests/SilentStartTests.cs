using System.Text.Json.Nodes;
using Xunit;

namespace TokenTrackerWin;

public sealed class SilentStartTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "tokentracker-silent-start-" + Guid.NewGuid().ToString("N"));
    private string SettingsPath => Path.Combine(_directory, "native-settings.json");

    public SilentStartTests() => Directory.CreateDirectory(_directory);

    [Fact]
    public void SetPreservesOtherPreferences()
    {
        File.WriteAllText(SettingsPath, "{\"Locale\":\"zh\",\"PetVisible\":true,\"StartSilently\":false}");

        Assert.True(SilentStart.Set(true, SettingsPath));

        var saved = JsonNode.Parse(File.ReadAllText(SettingsPath))!;
        Assert.Equal("zh", saved["Locale"]!.GetValue<string>());
        Assert.True(saved["PetVisible"]!.GetValue<bool>());
        Assert.True(saved["StartSilently"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData("{broken")]
    [InlineData("[]")]
    [InlineData("null")]
    public void SetRecoversFromMalformedSettings(string json)
    {
        File.WriteAllText(SettingsPath, json);

        Assert.True(SilentStart.Set(true, SettingsPath));
        Assert.True(JsonNode.Parse(File.ReadAllText(SettingsPath))!["StartSilently"]!.GetValue<bool>());
    }

    [Fact]
    public void SetCreatesMissingSettings()
    {
        Assert.True(SilentStart.Set(false, SettingsPath));
        Assert.False(JsonNode.Parse(File.ReadAllText(SettingsPath))!["StartSilently"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void SetDoesNotOverwriteWritableSettingsWhenReadingFails(bool unauthorized)
    {
        const string original = "{\"Locale\":\"zh\",\"PetVisible\":true,\"StartSilently\":false}";
        File.WriteAllText(SettingsPath, original);
        var reads = 0;
        string? requestedPath = null;
        // Deterministic even in privileged containers that bypass Unix modes.
        // Writing still uses the real writable fixture file.
        var saved = SilentStart.Set(true, SettingsPath, file =>
        {
            requestedPath = file;
            reads++;
            if (unauthorized) throw new UnauthorizedAccessException("Injected read denial");
            throw new IOException("Injected transient read error");
        });

        Assert.Equal(1, reads);
        Assert.Equal(SettingsPath, requestedPath);
        Assert.False(saved);
        Assert.Equal(original, File.ReadAllText(SettingsPath));
    }

    [Fact]
    public void SetPreservesReadLockedWindowsSettings()
    {
        if (!OperatingSystem.IsWindows()) return;
        const string original = "{\"Locale\":\"zh\",\"PetVisible\":true}";
        File.WriteAllText(SettingsPath, original);
        using (var denyOtherReaders = new FileStream(SettingsPath, FileMode.Open, FileAccess.Read, FileShare.Write))
        {
            Assert.ThrowsAny<IOException>(() => File.ReadAllText(SettingsPath));
            Assert.False(SilentStart.Set(true, SettingsPath));
        }
        Assert.Equal(original, File.ReadAllText(SettingsPath));
    }

    public void Dispose() => Directory.Delete(_directory, recursive: true);
}
