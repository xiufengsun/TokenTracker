using System.IO;
using System.Text.Json.Nodes;

namespace TokenTrackerWin;

/// <summary>
/// Persists the Windows automatic-update preference alongside the other native
/// settings. A missing value intentionally means enabled so existing installs
/// keep their historical update behaviour until the user turns it off.
/// </summary>
internal static class AutoUpdatePolicy
{
    public const string EnabledKey = "UpdateChecker.autoUpdateEnabled";

    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TokenTracker",
        "native-settings.json");

    public static bool IsEnabled() => ResolveEnabled(ReadSettings());

    /// <summary>Resolve a persisted settings object, defaulting to enabled.</summary>
    internal static bool ResolveEnabled(JsonObject? settings) =>
        settings?[EnabledKey]?.GetValue<bool>() ?? true;

    public static void SetEnabled(bool enabled)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            var settings = ReadSettings();
            settings[EnabledKey] = enabled;
            File.WriteAllText(SettingsPath, settings.ToJsonString());
        }
        catch
        {
            // Preferences are best effort. A failed write leaves the default-on
            // behaviour intact for the next launch.
        }
    }

    private static JsonObject ReadSettings()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return new JsonObject();
            return JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject() ?? new JsonObject();
        }
        catch
        {
            return new JsonObject();
        }
    }
}
