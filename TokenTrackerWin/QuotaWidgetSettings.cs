using System.IO;
using System.Text.Json;

namespace TokenTrackerWin;

internal sealed class QuotaWidgetSettings
{
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TokenTracker", "quota-widget.json");
    public bool Enabled { get; set; }
    public int? X { get; set; }
    public int? Y { get; set; }
    public string[] Selected { get; set; } = [];

    public static QuotaWidgetSettings Load()
    {
        try
        {
            var settings = JsonSerializer.Deserialize<QuotaWidgetSettings>(File.ReadAllText(FilePath)) ?? new();
            settings.Selected = (settings.Selected ?? []).Where(id => !string.IsNullOrWhiteSpace(id) && id.Length <= 100).Distinct().Take(2).ToArray();
            return settings;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return new(); }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath + ".tmp", JsonSerializer.Serialize(this));
            File.Move(FilePath + ".tmp", FilePath, true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Diag.Log("quota", $"settings save failed: {ex.Message}"); }
    }
}
