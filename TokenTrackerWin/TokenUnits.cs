using System.IO;
using System.Text.Json.Nodes;

namespace TokenTrackerWin;

/// <summary>
/// Native cache of the dashboard's token unit system (English K/M/B vs Chinese 万/亿),
/// mirroring macOS <c>TokenFormatter.unitSystemDefaultsKey</c>. The dashboard pushes it
/// via <c>setSetting("tokenUnitSystem", …)</c>; it is persisted so the tray summary and
/// the floating pet use the right units on a cold launch, before any WebView exists.
/// </summary>
internal static class TokenUnits
{
    public const string SettingKey = "tokenUnitSystem";
    public const string Chinese = "chinese";
    public const string English = "english";

    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TokenTracker",
        "native-settings.json");

    private static string? _cached;

    public static string Normalize(string? value) =>
        string.Equals(value?.Trim(), Chinese, StringComparison.OrdinalIgnoreCase) ? Chinese : English;

    public static string Current => _cached ??= ReadStored();

    public static bool UsesChinese => Current == Chinese;

    public static void Store(string? value)
    {
        var normalized = Normalize(value);
        _cached = normalized;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            var settings = ReadSettingsObject();
            settings["TokenUnitSystem"] = normalized;
            File.WriteAllText(SettingsPath, settings.ToJsonString());
        }
        catch { /* best-effort native preference cache */ }
    }

    private static string ReadStored()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return English;
            var settings = JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject();
            return Normalize(settings?["TokenUnitSystem"]?.GetValue<string>());
        }
        catch { return English; }
    }

    private static JsonObject ReadSettingsObject()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return new JsonObject();
            return JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject() ?? new JsonObject();
        }
        catch { return new JsonObject(); }
    }
}
