using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;

namespace TokenTrackerWin;

/// <summary>
/// Windows counterpart of <c>TokenTrackerBar/Services/UpdateChecker.swift</c>.
///
/// Checks the GitHub "latest release" for a newer version, downloads the
/// <c>TokenTracker-Setup.exe</c> asset, and runs it fully silently. Because a
/// silent Inno install does not relaunch the app (its <c>[Run]</c> postinstall is
/// <c>skipifsilent</c>), we drive the close → install → relaunch sequence
/// ourselves: a small detached <c>cmd</c> runs the installer and then restarts
/// this exe once the upgrade finishes (see <see cref="DownloadAndInstallAsync"/>).
///
/// This type does NO UI — it only manages state and raises <see cref="Changed"/>;
/// the tray context owns every dialog/balloon (mirrors how <see cref="UsagePoller"/>
/// stays UI-free). The HTTP client here, unlike the loopback ones in
/// <see cref="ServerManager"/>/<see cref="UsagePoller"/>, MUST honour the system /
/// env proxy: it talks to github.com (external), which CN proxy users can only
/// reach through their proxy — so it uses a default handler (UseProxy stays true).
/// </summary>
internal sealed class UpdateChecker
{
    public enum UpdateState { Idle, Checking, UpdateAvailable, Downloading, Installing }
    public enum CheckOutcome { UpToDate, UpdateAvailable, Failed, Skipped }

    private const string Repo = "xiufengsun/TokenTracker";

    // External host (github.com): keep the DEFAULT proxy behaviour so CN proxy/VPN
    // users can reach it. The long timeout covers the installer download; the quick
    // API check wraps its own short cancellation token instead.
    private static readonly HttpClient Http = CreateClient();

    private static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("TokenTracker-Windows-Updater");
        client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return client;
    }

    /// <summary>Raised (off the UI thread) whenever <see cref="State"/> or <see cref="ProgressPercent"/> changes.</summary>
    public event Action? Changed;

    /// <summary>Raised once the installer has been spawned; the tray must quit so its files unlock.</summary>
    public event Action? QuitRequested;

    public UpdateState State { get; private set; } = UpdateState.Idle;
    public string? LatestVersion { get; private set; }
    public int ProgressPercent { get; private set; }

    private string? _setupUrl;
    private long _setupSize;

    public string CurrentVersion { get; } = ResolveCurrentVersion();

    // ── Public API ─────────────────────────────────────────────────────

    /// <summary>
    /// Check GitHub for a newer release. <paramref name="silent"/> launch checks are
    /// skipped for dev builds (no embedded server next to the exe) so a developer run
    /// is never nudged to "update" to an official release. Installed builds perform
    /// the download/install hand-off automatically when the preference is enabled;
    /// manual checks remain available regardless of the preference.
    /// </summary>
    public async Task<CheckOutcome> CheckAsync(bool silent)
    {
        if (State is UpdateState.Checking or UpdateState.Downloading or UpdateState.Installing)
            return CheckOutcome.Skipped;
        if (silent && !AutoUpdatePolicy.IsEnabled())
        {
            Diag.Log("update", "silent check skipped: automatic updates disabled");
            return CheckOutcome.Skipped;
        }
        if (silent && !IsInstalledBuild())
        {
            Diag.Log("update", "silent check skipped: not an installed build");
            return CheckOutcome.Skipped;
        }

        SetState(UpdateState.Checking);
        try
        {
            var release = await FetchLatestReleaseAsync();
            if (release is null)
            {
                SetState(UpdateState.Idle);
                return CheckOutcome.Failed;
            }

            var latest = release.Value.Version;
            if (CompareVersions(CurrentVersion, latest) < 0 && release.Value.SetupUrl is not null)
            {
                LatestVersion = latest;
                _setupUrl = release.Value.SetupUrl;
                _setupSize = release.Value.SetupSize;
                SetState(UpdateState.UpdateAvailable);
                Diag.Log("update", $"update available current={CurrentVersion} latest={latest}");
                if (silent && AutoUpdatePolicy.IsEnabled())
                {
                    // The launch-time check is the unattended path. Start the same
                    // resumable installer flow used by the tray action; it asks the
                    // tray to quit only after the download is complete.
                    _ = DownloadAndInstallAsync();
                }
                return CheckOutcome.UpdateAvailable;
            }

            SetState(UpdateState.Idle);
            Diag.Log("update", $"up to date current={CurrentVersion} latest={latest}");
            return CheckOutcome.UpToDate;
        }
        catch (Exception ex)
        {
            Diag.Log("update", $"check failed: {ex.Message}");
            SetState(UpdateState.Idle);
            return CheckOutcome.Failed;
        }
    }

    /// <summary>Whether launch-time checks may download and install releases.</summary>
    public bool AutoUpdateEnabled
    {
        get => AutoUpdatePolicy.IsEnabled();
        set => AutoUpdatePolicy.SetEnabled(value);
    }

    /// <summary>
    /// Download the prepared setup asset and launch it silently, then ask the tray to
    /// quit so the installer can overwrite the running files and relaunch us. Must be
    /// called only after a check left <see cref="State"/> == <see cref="UpdateState.UpdateAvailable"/>.
    /// Returns false (and surfaces nothing) if there is no pending asset or the download fails.
    /// </summary>
    public async Task<bool> DownloadAndInstallAsync()
    {
        if (State != UpdateState.UpdateAvailable || _setupUrl is null) return false;

        SetState(UpdateState.Downloading);
        ProgressPercent = 0;
        Changed?.Invoke();

        string setupPath;
        try
        {
            setupPath = await DownloadSetupAsync(_setupUrl, _setupSize, LatestVersion ?? "unknown");
        }
        catch (Exception ex)
        {
            Diag.Log("update", $"download failed: {ex.Message}");
            SetState(UpdateState.UpdateAvailable);   // let the user retry
            return false;
        }

        SetState(UpdateState.Installing);
        try
        {
            LaunchSilentInstaller(setupPath);
        }
        catch (Exception ex)
        {
            Diag.Log("update", $"installer launch failed: {ex.Message}");
            SetState(UpdateState.UpdateAvailable);
            return false;
        }

        QuitRequested?.Invoke();
        return true;
    }

    // ── GitHub ─────────────────────────────────────────────────────────

    private readonly record struct ReleaseInfo(string Version, string? SetupUrl, long SetupSize);

    private static async Task<ReleaseInfo?> FetchLatestReleaseAsync()
    {
        var url = $"https://api.github.com/repos/{Repo}/releases/latest";
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        using var resp = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        if (!resp.IsSuccessStatusCode)
        {
            Diag.Log("update", $"github api status {(int)resp.StatusCode}");
            return null;
        }

        await using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cts.Token);
        var root = doc.RootElement;

        var tag = root.TryGetProperty("tag_name", out var t) ? t.GetString() ?? "" : "";
        var version = tag.StartsWith('v') ? tag[1..] : tag;
        if (string.IsNullOrWhiteSpace(version)) return null;

        string? setupUrl = null;
        long setupSize = 0;
        if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
        {
            foreach (var asset in assets.EnumerateArray())
            {
                var name = asset.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                // The release uploads a stable, version-less "TokenTracker-Setup.exe"
                // (release-windows.yml renames the versioned Inno output before upload).
                // Match it exactly so a future co-released .exe can't be picked instead.
                if (name.Equals("TokenTracker-Setup.exe", StringComparison.OrdinalIgnoreCase)
                    && asset.TryGetProperty("browser_download_url", out var u))
                {
                    setupUrl = u.GetString();
                    setupSize = asset.TryGetProperty("size", out var s) && s.TryGetInt64(out var sv) ? sv : 0;
                    break;
                }
            }
        }

        return new ReleaseInfo(version, setupUrl, setupSize);
    }

    // ── Download ───────────────────────────────────────────────────────

    private async Task<string> DownloadSetupAsync(string url, long expectedSize, string version)
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "TokenTracker", "updates");
        Directory.CreateDirectory(dir);
        var safeVersion = string.Concat(version.Select(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' ? c : '_'));
        var dest = Path.Combine(dir, $"TokenTracker-Setup-{safeVersion}.exe");
        try { File.Delete(Path.Combine(dir, "TokenTracker-Setup.exe")); } catch { }
        foreach (var stalePath in Directory.EnumerateFiles(dir, "TokenTracker-Setup-*"))
        {
            if (string.Equals(stalePath, dest, StringComparison.OrdinalIgnoreCase)
                || string.Equals(stalePath, dest + ".part", StringComparison.OrdinalIgnoreCase)
                || string.Equals(stalePath, dest + ".resume.json", StringComparison.OrdinalIgnoreCase))
                continue;
            try { File.Delete(stalePath); } catch { }
        }
        var lastPct = -1;
        var downloader = new ResumableDownloader(Http);
        await downloader.DownloadAsync(
            new Uri(url),
            dest,
            expectedSize,
            onProgress: (received, total) =>
            {
                if (total <= 0) return;
                var pct = (int)Math.Min(99, received * 100 / total);
                if (pct == lastPct) return;
                lastPct = pct;
                ProgressPercent = pct;
                Changed?.Invoke();
            },
            onRetry: (attempt, error) =>
                Diag.Log("update", $"download retry {attempt}: {error.Message}"));

        Diag.Log("update", $"downloaded setup -> {dest}");
        return dest;
    }

    // ── Install + relaunch ─────────────────────────────────────────────

    /// <summary>
    /// Run the installer fully silently and restart this exe once it finishes. The
    /// <c>cmd</c> we spawn is detached from this process (and from the server's job
    /// object), so it survives the tray quitting; the installer's <c>CloseApplications</c>
    /// is the backstop for any instance still holding a file lock. We restart via the
    /// current exe path so an in-place upgrade relaunches the same install location.
    /// </summary>
    private static void LaunchSilentInstaller(string setupPath)
    {
        var appExe = Environment.ProcessPath
                     ?? Path.Combine(AppContext.BaseDirectory, "TokenTracker.exe");

        // cmd /c ""<setup>" /VERYSILENT ... & start "" "<app>""
        // The setup runs inline (cmd waits for it); then `start` relaunches the app detached.
        var arguments =
            $"/c \"\"{setupPath}\" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART & start \"\" \"{appExe}\"\"";

        var psi = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = arguments,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = Path.GetTempPath(),
        };
        Process.Start(psi);
        Diag.Log("update", $"silent installer spawned: {setupPath} -> relaunch {appExe}");
    }

    // ── Helpers ────────────────────────────────────────────────────────

    private void SetState(UpdateState state)
    {
        if (State == state) return;
        State = state;
        Changed?.Invoke();
    }

    /// <summary>Installed builds ship the embedded server next to the exe; dev runs do not.</summary>
    private static bool IsInstalledBuild()
        => File.Exists(Path.Combine(AppContext.BaseDirectory, "EmbeddedServer", "node.exe"));

    private static string ResolveCurrentVersion()
    {
        var info = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrWhiteSpace(info))
            return Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
        // Strip the "+<sha>" / "-<suffix>" build metadata: "0.42.0+abc123" -> "0.42.0".
        return info.Split('+', '-')[0];
    }

    /// <summary>Numeric dotted compare. Returns &lt;0 if a&lt;b, 0 if equal, &gt;0 if a&gt;b.</summary>
    private static int CompareVersions(string a, string b)
    {
        var pa = a.Split('.');
        var pb = b.Split('.');
        var count = Math.Max(pa.Length, pb.Length);
        for (var i = 0; i < count; i++)
        {
            var va = i < pa.Length && int.TryParse(pa[i], out var x) ? x : 0;
            var vb = i < pb.Length && int.TryParse(pb[i], out var y) ? y : 0;
            if (va != vb) return va < vb ? -1 : 1;
        }
        return 0;
    }
}
