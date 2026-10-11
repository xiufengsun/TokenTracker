using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace TokenTrackerWin;

internal sealed record CloudUsageExportResult(
    [property: JsonPropertyName("requestId")] string RequestId,
    [property: JsonPropertyName("saved")] bool Saved,
    [property: JsonPropertyName("filename")] string? Filename = null,
    [property: JsonPropertyName("errorCode")] string? ErrorCode = null);

internal static class CloudUsageExport
{
    internal const int MaximumBytes = 5 * 1024 * 1024;
    private static readonly Regex FilenamePattern = new("\\Atokentracker-cloud-[A-Za-z0-9][A-Za-z0-9_-]{0,150}\\.(csv|json)\\z");
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly Guid DownloadsFolder = new("374DE290-123F-4565-9164-39C4925E467B");

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetKnownFolderPath(in Guid folder, uint flags, nint token, out nint path);

    internal static string GetDownloadsDirectory()
    {
        var result = SHGetKnownFolderPath(in DownloadsFolder, 0x00008000, nint.Zero, out var pointer);
        try
        {
            if (result != 0) throw new IOException("save_failed");
            return Marshal.PtrToStringUni(pointer) ?? throw new IOException("save_failed");
        }
        finally { Marshal.FreeCoTaskMem(pointer); }
    }

    internal static bool PermitsSource(string source, string current, string expected)
    {
        if (!Uri.TryCreate(expected, UriKind.Absolute, out var managed)) return false;
        return new[] { source, current }.All(raw => Uri.TryCreate(raw, UriKind.Absolute, out var uri)
            && uri.Scheme == "http" && managed.Scheme == "http"
            && uri.Host is "127.0.0.1" or "localhost"
            && uri.Host == managed.Host && uri.Port == managed.Port && string.IsNullOrEmpty(uri.UserInfo));
    }

    // The directory comes from the native known-folder API, never from the message.
    internal static CloudUsageExportResult Save(JsonElement message, string directory)
    {
        var requestId = message.TryGetProperty("requestId", out var request) && request.ValueKind == JsonValueKind.String
            ? request.GetString() ?? "" : "";
        try
        {
            var fields = message.EnumerateObject().Select(item => item.Name).ToArray();
            if (fields.Length != 5 || !fields.ToHashSet().SetEquals(new[] { "type", "requestId", "filename", "format", "content" })
                || !Guid.TryParseExact(requestId, "D", out _)
                || message.GetProperty("type").GetString() != "saveCloudUsageExport")
                return new(requestId, false, ErrorCode: "invalid_export");
            var filename = message.GetProperty("filename").GetString() ?? "";
            var format = message.GetProperty("format").GetString() ?? "";
            var content = message.GetProperty("content").GetString() ?? "";
            if (format is not ("csv" or "json") || !FilenamePattern.IsMatch(filename)
                || !filename.EndsWith("." + format, StringComparison.Ordinal)
                || content.Length == 0 || content.Contains('\0') || Utf8.GetByteCount(content) > MaximumBytes)
                return new(requestId, false, ErrorCode: "invalid_export");
            if (format == "json")
            {
                using var parsed = JsonDocument.Parse(content);
                if (parsed.RootElement.ValueKind != JsonValueKind.Object)
                    return new(requestId, false, ErrorCode: "invalid_export");
            }
            var bytes = Utf8.GetBytes(content);
            var stem = filename[..^(format.Length + 1)];
            for (var index = 0; index < 1000; index++)
            {
                var candidate = index == 0 ? filename : $"{stem}-{index}.{format}";
                var target = Path.Combine(directory, candidate);
                FileStream stream;
                try { stream = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None); }
                catch (IOException error) when ((error.HResult & 0xffff) is 80 or 183 or 17) { continue; }
                var succeeded = false;
                try
                {
                    using (stream) { stream.Write(bytes); stream.Flush(flushToDisk: true); }
                    succeeded = true;
                    return new(requestId, true, candidate);
                }
                finally { if (!succeeded) { try { File.Delete(target); } catch { } } }
            }
            return new(requestId, false, ErrorCode: "save_failed");
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException
                                      or EncoderFallbackException or ArgumentException)
        { return new(requestId, false, ErrorCode: "invalid_export"); }
        catch { return new(requestId, false, ErrorCode: "save_failed"); }
    }
}
