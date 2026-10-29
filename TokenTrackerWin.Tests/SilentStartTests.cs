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

    [Fact]
    public void SetDoesNotOverwriteWritableSettingsWhenReadingIsDenied()
    {
        const string original = "{\"Locale\":\"zh\",\"PetVisible\":true,\"StartSilently\":false}";
        File.WriteAllText(SettingsPath, original);
        bool saved;
        if (OperatingSystem.IsWindows())
        {
            // Deny readers while allowing writers: the old broad catch would
            // swallow the read failure, overwrite the file, and return true.
            using var denyOtherReaders = new FileStream(SettingsPath, FileMode.Open, FileAccess.Read, FileShare.Write);
            Assert.ThrowsAny<IOException>(() => File.ReadAllText(SettingsPath));
            saved = SilentStart.Set(true, SettingsPath);
        }
        else
        {
            var mode = File.GetUnixFileMode(SettingsPath);
            File.SetUnixFileMode(SettingsPath, UnixFileMode.UserWrite);
            try
            {
                Assert.Throws<UnauthorizedAccessException>(() => File.ReadAllText(SettingsPath));
                saved = SilentStart.Set(true, SettingsPath);
            }
            finally
            {
                File.SetUnixFileMode(SettingsPath, mode);
            }
        }

        Assert.False(saved);
        Assert.Equal(original, File.ReadAllText(SettingsPath));
    }

    public void Dispose() => Directory.Delete(_directory, recursive: true);
}
