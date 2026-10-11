using System.Text;
using System.Text.Json;
using Xunit;

namespace TokenTrackerWin;

// These filesystem tests never load the desktop app or open a URI.
public sealed class CloudUsageExportTests
{
    private static readonly string RequestId = "00112233-4455-4677-8899-aabbccddeeff";
    private static JsonElement Message(string filename = "tokentracker-cloud-usage.csv", string format = "csv", string content = "date,tokens\nsynthetic,4\n")
        => JsonSerializer.SerializeToElement(new { type = "saveCloudUsageExport", requestId = RequestId, filename, format, content });

    [Fact]
    public void WritesBoundedUtf8AndRetainsExistingFiles()
    {
        var directory = Path.Combine(Path.GetTempPath(), "tokentracker-export-test-" + Guid.NewGuid());
        Directory.CreateDirectory(directory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        try
        {
            var request = Message(content: "date,tokens\n合成,4\n");
            var result = CloudUsageExport.Save(request, directory);
            Assert.True(result.Saved && result.Filename == "tokentracker-cloud-usage.csv");
            Assert.True(File.ReadAllBytes(Path.Combine(directory, result.Filename!)).SequenceEqual(Encoding.UTF8.GetBytes("date,tokens\n合成,4\n")));
            var collision = CloudUsageExport.Save(Message(), directory);
            Assert.True(collision.Saved && collision.Filename == "tokentracker-cloud-usage-1.csv");
            Assert.True(File.ReadAllText(Path.Combine(directory, result.Filename!)) == "date,tokens\n合成,4\n");

            var before = Directory.GetFiles(directory).Length;
            foreach (var filename in new[] { "../tokentracker-cloud-a.csv", "/tokentracker-cloud-a.csv", "tokentracker-cloud-a\\b.csv",
                "tokentracker-cloud-a.csv\n", "tokentracker-cloud-a.json", "other.csv", "tokentracker-cloud-a.exe" })
                Assert.True(CloudUsageExport.Save(Message(filename: filename), directory).ErrorCode == "invalid_export");
            foreach (var content in new[] { "a\0b", new string('字', CloudUsageExport.MaximumBytes / 3 + 1), "" })
                Assert.True(CloudUsageExport.Save(Message(content: content), directory).ErrorCode == "invalid_export");
            foreach (var content in new[] { "[]", "broken", "null" })
                Assert.True(CloudUsageExport.Save(Message(filename: "tokentracker-cloud-a.json", format: "json", content: content), directory).ErrorCode == "invalid_export");
            var extra = JsonSerializer.SerializeToElement(new { type = "saveCloudUsageExport", requestId = RequestId,
                filename = "tokentracker-cloud-a.csv", format = "csv", content = "synthetic", directory = "/tmp" });
            Assert.True(CloudUsageExport.Save(extra, directory).ErrorCode == "invalid_export");
            Assert.True(Directory.GetFiles(directory).Length == before);
            Assert.True(CloudUsageExport.Save(Message(filename: "tokentracker-cloud-exact.csv", content: new string('a', CloudUsageExport.MaximumBytes)), directory).Saved);
            Assert.True(CloudUsageExport.Save(Message(filename: "tokentracker-cloud-a.json", format: "json", content: "{\"synthetic\":true}"), directory).Saved);
            var failed = CloudUsageExport.Save(Message(), Path.Combine(directory, "missing"));
            Assert.True(!failed.Saved && failed.ErrorCode == "save_failed" && failed.RequestId == RequestId);
            Assert.True(!JsonSerializer.Serialize(failed).Contains(directory));


        }
        finally { Directory.Delete(directory, recursive: true); }
    }
    [CloudExportSymlinkFact]
    public void SymlinkDoesNotOverwriteItsTarget()
    {
        var directory = Path.Combine(Path.GetTempPath(), "tokentracker-export-test-" + Guid.NewGuid());
        Directory.CreateDirectory(directory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        try
        {
            var retained = Path.Combine(directory, "retained.txt"); File.WriteAllText(retained, "keep");
            File.CreateSymbolicLink(Path.Combine(directory, "tokentracker-cloud-linked.csv"), retained);
            var symlink = CloudUsageExport.Save(Message(filename: "tokentracker-cloud-linked.csv"), directory);
            Assert.True(symlink.Saved && symlink.Filename == "tokentracker-cloud-linked-1.csv");
            Assert.True(File.ReadAllText(retained) == "keep");

        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public void SourceMustMatchTheCurrentManagedLoopbackOrigin()
    {
            const string origin = "http://127.0.0.1:51956";
            Assert.True(CloudUsageExport.PermitsSource(origin + "/dashboard", origin + "/cloud", origin));
            foreach (var other in new[] { "http://127.0.0.1:7680", "http://localhost:51956", "https://127.0.0.1:51956",
                "http://user@127.0.0.1:51956", "https://hosted.example" })
            {
                Assert.True(!CloudUsageExport.PermitsSource(other, origin, origin));
                Assert.True(!CloudUsageExport.PermitsSource(origin, other, origin));
            }

    }
}

internal sealed class CloudExportSymlinkFactAttribute : FactAttribute
{
    public CloudExportSymlinkFactAttribute()
    {
        if (OperatingSystem.IsWindows())
            Skip = "Windows symlink creation requires Developer Mode or privilege; this portable test does not request either.";
    }
}
