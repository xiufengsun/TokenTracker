using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;

namespace TokenTrackerWin;

/// <summary>
/// Windows counterpart of <c>TokenTrackerBar/Services/ServerManager.swift</c>.
/// Resolves a Node runtime + the tracker CLI entry, then launches
/// <c>tracker serve --port P</c> on a port this process picked as free, and
/// keeps a lightweight health-check loop running.
///
/// Why we choose the port instead of using the CLI default 7680:
/// on Windows, Delivery Optimization (DoSvc) binds <c>::7680</c> dual-stack,
/// which also reserves IPv4 7680 — so a fixed 7680 frequently fails with EACCES.
/// The CLI would auto-increment to the next free port, but then the app
/// wouldn't know which port it landed on. Pre-selecting a free loopback port
/// and passing it explicitly keeps the URL deterministic.
///
/// Runtime resolution (mirrors the macOS "embedded first, dev fallback" logic):
///   1. Embedded runtime bundled next to the exe (EmbeddedServer\node.exe + tokentracker\bin\tracker.js).
///   2. Dev override via env vars TOKENTRACKER_NODE / TOKENTRACKER_ENTRY (local self-test against the repo).
///   3. Dev auto-detect: walk up from the build output and use the repo's bin\tracker.js.
/// </summary>
internal sealed class ServerManager : IDisposable
{
    public enum ServerStatus { Idle, Starting, Running, Failed }

    public ServerStatus Status { get; private set; } = ServerStatus.Idle;
    public string? LastError { get; private set; }

    /// <summary>The port the server was launched on. Valid once Status is Running.</summary>
    public int Port { get; private set; }

    /// <summary>Base URL for the local dashboard/API. Always IPv4 loopback (see class remarks).</summary>
    public string BaseUrl => $"http://127.0.0.1:{Port}";

    private Process? _serverProcess;
    private Process? _syncProcess;
    private CancellationTokenSource? _backgroundSyncCts;
    private bool _syncInFlight;
    private readonly object _syncLock = new();
    private readonly JobObject _job = new();
    private CancellationTokenSource? _healthCts;
    // The local server is always on 127.0.0.1, so this client must NEVER honour a system /
    // env (HTTP_PROXY) proxy: a VPN/proxy user with no loopback bypass would otherwise have
    // the health check routed through the proxy, which can't reach the local server — the
    // app then thinks startup failed even though the server is up. UseProxy=false = direct.
    private static readonly HttpClient Http =
        new(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(3) };

    // The local API owns its configured network timeouts (which may be
    // unbounded) and its 120s sync-child timeout. Do not impose a finite
    // native timeout that could release the single-flight slot while the
    // server is still publishing; shutdown cancels this request and kills the
    // server/child process instead.
    private static readonly HttpClient LocalSyncHttp =
        new(new HttpClientHandler { UseProxy = false }) { Timeout = Timeout.InfiniteTimeSpan };

    /// <summary>Raised on the thread-pool when the running state flips. UI must marshal to the UI thread.</summary>
    public event Action<ServerStatus>? StatusChanged;

    /// <summary>Raised on the thread-pool when a sync process starts. UI must marshal if needed.</summary>
    public event Action? SyncStarted;

    /// <summary>Raised on the thread-pool after a sync process exits. UI must marshal if needed.</summary>
    public event Action? SyncCompleted;

    public async Task EnsureServerRunningAsync()
    {
        Log("EnsureServerRunningAsync start");
        SetStatus(ServerStatus.Starting);

        var runtime = FindEmbeddedServer() ?? FindDevServer() ?? FindRepoDevServer();
        if (runtime is null)
        {
            Fail("No embedded server bundle found and no Node CLI available. "
                 + "Run scripts\\bundle-node.ps1, or set TOKENTRACKER_NODE / TOKENTRACKER_ENTRY for dev.");
            return;
        }
        Log($"runtime node={runtime.Value.NodePath} entry={runtime.Value.EntryPath}");

        Port = PickServerPort();
        Log($"picked port {Port}");
        LaunchServer(runtime.Value.NodePath, runtime.Value.EntryPath);

        if (await WaitForServerAsync(TimeSpan.FromSeconds(Constants.StartupTimeoutSeconds)))
        {
            SetStatus(ServerStatus.Running);
            StartHealthLoop();
        }
        else
        {
            Fail($"Server did not respond on {BaseUrl} within {Constants.StartupTimeoutSeconds}s.");
        }
    }

    /// <summary>Run a one-shot `tracker sync` against the resolved runtime.</summary>
    public void TriggerSync()
    {
        StartDirectSync();
    }

    /// <summary>Run a quiet, non-overlapping background sync for live tray totals.</summary>
    public void TriggerBackgroundSync()
    {
        CancellationTokenSource cts;
        lock (_syncLock)
        {
            if (_syncInFlight) return;

            cts = new CancellationTokenSource();
            _backgroundSyncCts = cts;
            _syncInFlight = true;
            SyncStarted?.Invoke();
        }

        // Keep the timer/UI thread free while the local API runs the sync child.
        _ = RunBackgroundSyncAsync(cts);
    }

    private bool StartDirectSync()
    {
        var runtime = FindEmbeddedServer() ?? FindDevServer() ?? FindRepoDevServer();
        if (runtime is null) return false;

        lock (_syncLock)
        {
            if (_syncInFlight) return false;

            var args = new[] { "sync" };
            var proc = StartTrackerProcess(
                runtime.Value.NodePath, runtime.Value.EntryPath,
                false, args);
            if (proc is null) return false;

            _syncInFlight = true;
            _syncProcess = proc;
            proc.EnableRaisingEvents = true;
            proc.Exited += (_, _) =>
            {
                try { Log($"sync process exited code={proc.ExitCode}"); }
                catch { /* process may already be disposed */ }
                lock (_syncLock)
                {
                    if (ReferenceEquals(_syncProcess, proc)) _syncProcess = null;
                    _syncInFlight = false;
                }
                try { proc.Dispose(); } catch { }
                SyncCompleted?.Invoke();
            };
            SyncStarted?.Invoke();
            return true;
        }
    }

    private async Task RunBackgroundSyncAsync(CancellationTokenSource cts)
    {
        try
        {
            await new LocalSyncPublisher(LocalSyncHttp, BaseUrl).PublishAsync(cts.Token);
        }
        catch (OperationCanceledException) when (cts.IsCancellationRequested)
        {
            Log("background sync cancelled");
        }
        catch (Exception ex)
        {
            // Never include the local-auth response/header in diagnostics.
            Log($"background sync failed ({ex.GetType().Name})");
        }
        finally
        {
            lock (_syncLock)
            {
                if (ReferenceEquals(_backgroundSyncCts, cts)) _backgroundSyncCts = null;
                _syncInFlight = false;
            }
            cts.Dispose();
            SyncCompleted?.Invoke();
        }
    }

    public void StopServer()
    {
        _healthCts?.Cancel();
        _healthCts = null;

        lock (_syncLock)
        {
            if (_syncProcess is { HasExited: false } sync)
            {
                try { sync.Kill(entireProcessTree: true); }
                catch { /* already gone */ }
            }
            _syncProcess = null;
        }

        // Cancel an in-flight authenticated background request without waiting
        // on the UI thread. The server process is killed below as part of the
        // same shutdown path.
        lock (_syncLock)
        {
            _backgroundSyncCts?.Cancel();
        }

        if (_serverProcess is { HasExited: false } p)
        {
            try { p.Kill(entireProcessTree: true); }
            catch { /* already gone */ }
        }
        _serverProcess = null;
    }

    // ── Port selection ─────────────────────────────────────────────────

    // OAuth (Google/GitHub) redirects to http://127.0.0.1:<port>/auth/callback, which
    // must be in InsForge's allowed-redirect-URL list. A dynamic port can't be, so we
    // prefer this fixed port (registered in the InsForge allow-list alongside the macOS
    // app's :7680). It sits in the IANA "registered" range (10000–49151), so Windows
    // won't hand it out as an ephemeral port, and it avoids the DoSvc-held :7680.
    private const int PreferredPort = 17680;

    /// <summary>
    /// Prefer the OAuth-allow-listed fixed port; fall back to an OS-assigned free
    /// loopback port if it's taken (login still works for email; OAuth needs the fixed
    /// port to match the redirect allow-list). The CLI re-binds the chosen port a moment
    /// later; the race window is negligible on loopback.
    /// </summary>
    private static int PickServerPort()
    {
        if (IsLoopbackPortBindable(PreferredPort)) return PreferredPort;
        Log($"preferred port {PreferredPort} unavailable; falling back to a dynamic port");
        return PickFreeLoopbackPort();
    }

    /// <summary>True if 127.0.0.1:<paramref name="port"/> can currently be bound.</summary>
    private static bool IsLoopbackPortBindable(int port)
    {
        try
        {
            var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            listener.Stop();
            return true;
        }
        catch { return false; }
    }

    /// <summary>Bind an OS-assigned free port on the IPv4 loopback, then release it.</summary>
    private static int PickFreeLoopbackPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try { return ((IPEndPoint)listener.LocalEndpoint).Port; }
        finally { listener.Stop(); }
    }

    // ── Runtime resolution ─────────────────────────────────────────────

    private static (string NodePath, string EntryPath)? FindEmbeddedServer()
    {
        var baseDir = AppContext.BaseDirectory;
        var nodePath = Path.Combine(baseDir, "EmbeddedServer", "node.exe");
        var entryPath = Path.Combine(baseDir, "EmbeddedServer", "tokentracker", "bin", "tracker.js");
        return File.Exists(nodePath) && File.Exists(entryPath)
            ? (nodePath, entryPath)
            : null;
    }

    /// <summary>Dev fallback: system Node + an explicit tracker.js, for self-test against the repo.</summary>
    private static (string NodePath, string EntryPath)? FindDevServer()
    {
        var entry = Environment.GetEnvironmentVariable("TOKENTRACKER_ENTRY");
        if (string.IsNullOrWhiteSpace(entry) || !File.Exists(entry)) return null;

        var node = Environment.GetEnvironmentVariable("TOKENTRACKER_NODE");
        if (string.IsNullOrWhiteSpace(node) || !File.Exists(node))
        {
            node = ResolveOnPath("node.exe");
        }
        return node is not null ? (node, entry) : null;
    }

    /// <summary>When running the Debug exe from this repo, find the repo CLI without extra env vars.</summary>
    private static (string NodePath, string EntryPath)? FindRepoDevServer()
    {
        var node = ResolveOnPath("node.exe");
        if (node is null) return null;

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var entry = Path.Combine(dir.FullName, "bin", "tracker.js");
            var packageJson = Path.Combine(dir.FullName, "package.json");
            if (File.Exists(entry) && File.Exists(packageJson))
            {
                return (node, entry);
            }
            dir = dir.Parent;
        }
        return null;
    }

    private static string? ResolveOnPath(string exe)
    {
        var pathVar = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(pathVar)) return null;
        foreach (var dir in pathVar.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            try
            {
                var candidate = Path.Combine(dir.Trim(), exe);
                if (File.Exists(candidate)) return candidate;
            }
            catch { /* malformed PATH entry */ }
        }
        return null;
    }

    // ── Process launch ─────────────────────────────────────────────────

    private void LaunchServer(string nodePath, string entryPath)
    {
        try
        {
            Log("LaunchServer start");
            _serverProcess = StartTrackerProcess(
                nodePath, entryPath, false,
                "serve", "--port", Port.ToString(), "--no-sync", "--no-open");

            if (_serverProcess is not null)
            {
                Log($"server process pid={_serverProcess.Id}");
                // Backstop: if the tray app dies abnormally, the job kills the server too.
                _job.Assign(_serverProcess.Handle);
                _serverProcess.EnableRaisingEvents = true;
                _serverProcess.Exited += (_, _) =>
                {
                    if (Status == ServerStatus.Running)
                        Fail("Server process exited unexpectedly.");
                };
            }
        }
        catch (Exception ex)
        {
            Log($"LaunchServer failed: {ex}");
            Fail($"Failed to launch server: {ex.Message}");
        }
    }

    private static Process? StartTrackerProcess(
        string nodePath,
        string entryPath,
        bool forceNativeOnlyWslMode,
        params string[] args)
    {
        var psi = new ProcessStartInfo
        {
            FileName = nodePath,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetTempPath(),
        };
        psi.ArgumentList.Add(entryPath);
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["NODE_ENV"] = "production";
        psi.Environment["TOKENTRACKER_APP_SHELL"] = "windows";
        if (forceNativeOnlyWslMode)
            psi.Environment["TOKENTRACKER_WSL_MODE"] = "native-only";

        var proxySource = ChildProcessProxy.Configure(psi.Environment, HttpClient.DefaultProxy);
        if (proxySource != ChildProcessProxySource.None)
            Log($"node child proxy source={proxySource}");

        Log($"StartTrackerProcess file={nodePath} entry={entryPath} args={string.Join(" ", args)}");
        var proc = Process.Start(psi);
        // Drain pipes so the child never blocks on a full stdout/stderr buffer.
        if (proc is not null)
        {
            proc.OutputDataReceived += (_, e) => { if (e.Data is not null) Log($"node stdout: {e.Data}"); };
            proc.ErrorDataReceived += (_, e) => { if (e.Data is not null) Log($"node stderr: {e.Data}"); };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
        }
        return proc;
    }

    // ── Health checks ──────────────────────────────────────────────────

    private async Task<bool> WaitForServerAsync(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        var delayMs = 200;
        while (DateTime.UtcNow < deadline)
        {
            if (await CheckHealthAsync()) return true;
            await Task.Delay(delayMs);
            delayMs = Math.Min(delayMs * 2, 2000);
        }
        return false;
    }

    private async Task<bool> CheckHealthAsync()
    {
        try
        {
            using var resp = await Http.GetAsync(
                BaseUrl + "/", HttpCompletionOption.ResponseHeadersRead);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private void StartHealthLoop()
    {
        _healthCts?.Cancel();
        _healthCts = new CancellationTokenSource();
        var token = _healthCts.Token;
        _ = Task.Run(async () =>
        {
            // Debounce: a single transient probe failure (GC pause, brief load) should not
            // flip the server to Failed — that stops the sync timer and pops a warning
            // balloon. Only declare failure after several consecutive misses.
            const int failureThreshold = 3;
            var consecutiveFailures = 0;
            while (!token.IsCancellationRequested)
            {
                try { await Task.Delay(TimeSpan.FromSeconds(Constants.HealthCheckIntervalSeconds), token); }
                catch (TaskCanceledException) { break; }
                if (token.IsCancellationRequested) break;
                if (await CheckHealthAsync())
                {
                    consecutiveFailures = 0;
                    SetStatus(ServerStatus.Running);
                }
                else if (++consecutiveFailures >= failureThreshold)
                {
                    SetStatus(ServerStatus.Failed);
                }
            }
        }, token);
    }

    // ── State ──────────────────────────────────────────────────────────

    private void SetStatus(ServerStatus status)
    {
        if (Status == status) return;
        Status = status;
        if (status != ServerStatus.Failed) LastError = null;
        StatusChanged?.Invoke(status);
    }

    private void Fail(string message)
    {
        Log($"Fail: {message}");
        LastError = message;
        Status = ServerStatus.Failed;
        StatusChanged?.Invoke(ServerStatus.Failed);
    }

    private static void Log(string message) => Diag.Log("server", message);

    public void Dispose()
    {
        StopServer();
        _job.Dispose();
    }
}
