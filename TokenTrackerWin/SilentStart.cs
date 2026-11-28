using System.IO;
using System.Text.Json;
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

    /// <summary>Read-modify-write so the other keys in the shared file survive;
    /// a corrupted file is rebuilt instead of bricking the toggle until the user
    /// deletes it by hand. Returns whether the write landed, so callers can avoid
    /// showing an unsaved value; failures keep the swallow policy (never take the
    /// tray app down).</summary>
    public static bool Set(bool value) => Set(value, SettingsPath);

    internal static bool Set(bool value, string settingsPath, Func<string, string>? readAllText = null)
    {
        try
        {
            var root = new JsonObject();
            if (File.Exists(settingsPath))
            {
                // Read failures must reach the outer catch without writing: a
                // temporarily unreadable file can still be writable and valid.
                var json = (readAllText ?? File.ReadAllText)(settingsPath);
                try
                {
                    root = JsonNode.Parse(json) as JsonObject ?? root;
                }
                catch (JsonException)
                {
                    // Corrupted JSON: the keys are unreadable anyway, so rebuilding
                    // beats refusing every future write of this switch.
                }
            }
            root[Key] = value;
            Directory.CreateDirectory(Path.GetDirectoryName(settingsPath)!);
            File.WriteAllText(settingsPath, root.ToJsonString());
            return true;
        }
        catch
        {
            // Same swallow-as-existing-helpers policy: a failed preference write must
            // never take the tray app down.
            return false;
        }
    }
}
