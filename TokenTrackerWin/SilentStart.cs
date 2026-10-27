using System.IO;
using System.Text.Json.Nodes;

namespace TokenTrackerWin;

/// <summary>
/// The persisted "Silent Start" preference: when enabled, app launches stay in the
/// tray (no pet, no dashboard) instead of showing any panel. Stored in the shared
/// native-settings.json next to the locale/theme/pet keys.
/// </summary>
internal static class SilentStart
{
    // Same value as NativeLocalization/PetWindow declare privately; each helper keeps
    // its own copy by convention (no shared symbol exists).
    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TokenTracker", "native-settings.json");

    private const string Key = "StartSilently";

    /// <summary>Missing file/key or corrupted JSON falls back to false.</summary>
    public static bool Enabled
    {
        get
        {
            try
            {
                if (!File.Exists(SettingsPath)) return false;
                var root = JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject();
                return root?[Key]?.GetValue<bool>() ?? false;
            }
            catch { return false; }
        }
    }

    /// <summary>Read-modify-write so the other keys in the shared file survive.</summary>
    public static void Set(bool value)
    {
        try
        {
            var root = File.Exists(SettingsPath)
                ? JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject() ?? new JsonObject()
                : new JsonObject();
            root[Key] = value;
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            File.WriteAllText(SettingsPath, root.ToJsonString());
        }
        catch
        {
            // Same swallow-as-existing-helpers policy: a failed preference write must
            // never take the tray app down.
        }
    }
}
