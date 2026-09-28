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
    private readonly SemaphoreSlim _serverGate = new(1, 1);
    private readonly object _restartLock = new();
    private readonly JobObject _job = new();
    private CancellationTokenSource? _healthCts;
    // Each health loop owns a generation.  A cancelled loop can still resume
    // once after cancellation (for example when its HTTP probe completes), so
    // it must not mutate state belonging to a newer server process.
    private long _healthGeneration;
    private Task? _restartTask;
    // Shutdown is requested on the UI thread but observed by process/health
    // callbacks and startup continuations on pool threads.  Volatile keeps the
    // stop barrier visible before any of those threads decide to launch work.
    private volatile bool _stopping;
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

    // An unbounded client timeout still needs a ceiling on the single-flight
    // slot.  A loopback read can hang forever when the socket dies without an
    // RST -- a suspended laptop overnight is the common case -- and the slot is
    // only released in RunBackgroundSyncAsync's finally.  While it is held,
    // TriggerBackgroundSync returns at the _syncInFlight guard and StartDirectSync
    // returns at the _backgroundSyncCts guard, so the timer AND the "Sync Now"
    // menu item both become silent no-ops until the app is restarted, even
    // though `tracker sync` in a terminal still works.  Cancel well above the
    // local API's own 120s sync-child budget so a slow but live publish is
    // never cut short.
    private static readonly TimeSpan BackgroundSyncDeadline = TimeSpan.FromMinutes(5);

    /// <summary>Raised on the thread-pool when the running state flips. UI must marshal to the UI thread.</summary>
    public event Action<ServerStatus>? StatusChanged;

    /// <summary>Raised on the thread-pool when a sync process starts. UI must marshal if needed.</summary>
    public event Action? SyncStarted;

    /// <summary>Raised on the thread-pool after a sync process exits. UI must marshal if needed.</summary>
    public event Action? SyncCompleted;

    public Task EnsureServerRunningAsync() => EnsureServerRunningAsyncCore(allowRecovery: false);

    private async Task EnsureServerRunningAsyncCore(bool allowRecovery)
    {
        try
        {
            await _serverGate.WaitAsync().ConfigureAwait(false);
            try
            {
                var currentProcess = Volatile.Read(ref _serverProcess);
                if (_stopping
                    || (!allowRecovery && _restartTask is { IsCompleted: false })
                    // Process.HasExited throws after another thread disposes the
                    // handle.  Use the guarded liveness helper instead of a
                    // property-pattern access so a stop/restart race cannot turn
                    // into an unobserved startup exception.
                    || (Status == ServerStatus.Running
                        && currentProcess is not null
                        && IsProcessAlive(currentProcess)))
                    return;

                Log("EnsureServerRunningAsync start");
                SetStatus(ServerStatus.Starting);
                await StartServerOnceAsync().ConfigureAwait(false);
            }
            finally
            {
                _serverGate.Release();
            }
        }
        catch (Exception ex)
        {
            // This method is intentionally safe to call fire-and-forget from the
            // tray constructor and recovery loop. Convert unexpected startup errors
            // into observable state instead of an unobserved task that can terminate
            // the process under a strict UnobservedTaskException policy.
            Log($"EnsureServerRunningAsync failed: {ex}");
            if (!_stopping)
            {
                Fail($"Failed to start local server: {ex.Message}");
                RequestRestart("startup exception");
            }
        }
    }

    private async Task StartServerOnceAsync()
    {
        if (_stopping) return;

        var runtime = FindEmbeddedServer() ?? FindDevServer() ?? FindRepoDevServer();
        if (runtime is null)
        {
            Fail("No embedded server bundle found and no Node CLI available. "
                 + "Run scripts\\bundle-node.ps1, or set TOKENTRACKER_NODE / TOKENTRACKER_ENTRY for dev.");
            RequestRestart("runtime unavailable");
            return;
        }

        Log($"runtime node={runtime.Value.NodePath} entry={runtime.Value.EntryPath}");
        StopServerProcessOnly();
        // StopServer can win while runtime discovery was in progress.  Do not
        // allocate a port or launch a child after the owner has begun closing.
        if (_stopping) return;
        Port = PickServerPort();
        Log($"picked port {Port}");
        if (_stopping) return;
        var expectedBaseUrl = BaseUrl;
        var process = LaunchServer(runtime.Value.NodePath, runtime.Value.EntryPath);

        // LaunchServer can race StopServer after its own initial check.  Make
        // the caller's boundary defensive as well so a just-created child is
        // never left behind when shutdown wins that window.
        if (_stopping)
        {
            CleanupLaunchedProcess(process);
            return;
        }

        // Keep the process returned by this launch throughout startup.  A stale
        // health response must never make a replacement process look ready.
        if (!_stopping
            && process is not null
            && await WaitForServerAsync(
                process,
                expectedBaseUrl,
                TimeSpan.FromSeconds(Constants.StartupTimeoutSeconds)).ConfigureAwait(false)
            && IsCurrentServerProcess(process))
        {
            if (_stopping || !IsCurrentServerProcess(process)) return;
            SetStatus(ServerStatus.Running);
            StartHealthLoop(process, expectedBaseUrl);

            // The process can exit between the final probe and the status/event
            // transition. Revalidate after starting the monitor before claiming
            // readiness to the UI.
            if (_stopping || IsCurrentServerProcess(process)) return;
        }

        if (_stopping) return;

        // OnServerProcessExited already detached a dead process and scheduled
        // recovery. Do not overwrite its Starting state with a misleading
        // startup timeout (or schedule a second recovery chain).
        if (process is not null
            && !ReferenceEquals(Volatile.Read(ref _serverProcess), process)) return;

        if (process is not null) StopServerProcessOnly();
        Fail($"Server did not respond on {BaseUrl} within {Constants.StartupTimeoutSeconds}s.");
        RequestRestart("startup timeout");
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
            if (_stopping || Status != ServerStatus.Running || _syncInFlight) return;

            cts = new CancellationTokenSource();
            cts.CancelAfter(BackgroundSyncDeadline);
            _backgroundSyncCts = cts;
            _syncInFlight = true;
            RaiseSyncStarted();
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
            // A process callback disposes the handle as soon as it exits.  Reading
            // HasExited through a property pattern can therefore throw in this
            // critical section and leave a stale sync slot behind.  Treat a
            // disposed/exited instance as idle and clear it before starting the
            // replacement.
            if (_stopping || _backgroundSyncCts is not null) return false;
            if (_syncProcess is { } existing)
            {
                if (IsProcessAlive(existing)) return false;
                _syncProcess = null;
                _syncInFlight = false;
                try { existing.Dispose(); } catch { }
            }
            if (_syncInFlight) return false;

            var args = new[] { "sync" };
            var proc = StartTrackerProcess(
                runtime.Value.NodePath, runtime.Value.EntryPath,
                false, args);
            if (proc is null) return false;

            _syncInFlight = true;
            _syncProcess = proc;
            // Attach the handler before enabling events.  A short-lived sync can
            // exit between Process.Start and EnableRaisingEvents; subscribing
            // afterwards loses the only cleanup notification and blocks every
            // later refresh behind a permanently "running" process.
            proc.Exited += (_, _) => OnSyncProcessExited(proc);
            try
            {
                proc.EnableRaisingEvents = true;
            }
            catch
            {
                // If event registration itself fails, do not leave the process
                // occupying the single-flight slot or leak the child.
                if (ReferenceEquals(_syncProcess, proc))
                {
                    _syncProcess = null;
                    _syncInFlight = false;
                }
                try { proc.Kill(entireProcessTree: true); } catch { }
                try { proc.Dispose(); } catch { }
                return false;
            }
            RaiseSyncStarted();
            return true;
        }
    }

    private void OnSyncProcessExited(Process process)
    {
        try { Log($"sync process exited code={process.ExitCode}"); }
        catch { /* process may already be disposed */ }

        bool wasCurrent;
        lock (_syncLock)
        {
            wasCurrent = ReferenceEquals(_syncProcess, process);
            if (wasCurrent)
            {
                _syncProcess = null;
                _syncInFlight = false;
            }
        }
        try { process.Dispose(); } catch { }
        // EnableRaisingEvents may report an already-exited process immediately,
        // and a defensive manual cleanup can race that callback.  Only the
        // callback that owns the slot emits one completion notification.
        if (wasCurrent) RaiseSyncCompleted();
    }

    private async Task RunBackgroundSyncAsync(CancellationTokenSource cts)
    {
        try
        {
            await new LocalSyncPublisher(LocalSyncHttp, BaseUrl).PublishAsync(cts.Token);
        }
        catch (OperationCanceledException) when (cts.IsCancellationRequested)
        {
            // Shutdown and the BackgroundSyncDeadline watchdog land in the same
            // catch; name them apart so a wedged loopback read is visible in the
            // log instead of looking like an ordinary quit.
            Log(_stopping ? "background sync cancelled" : "background sync deadline exceeded");
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
                if (ReferenceEquals(_backgroundSyncCts, cts))
                {
                    _backgroundSyncCts = null;
                    _syncInFlight = false;
                }
            }
            cts.Dispose();
            RaiseSyncCompleted();
        }
    }

    public void StopServer()
    {
        _stopping = true;
        StopServerProcessOnly();

        lock (_syncLock)
        {
            if (_syncProcess is { } sync)
            {
                _syncProcess = null;
                _syncInFlight = false;
                try
                {
                    if (IsProcessAlive(sync)) sync.Kill(entireProcessTree: true);
                }
                catch { /* already gone */ }
                try { sync.Dispose(); } catch { }
            }
        }
    }

    private void StopServerProcessOnly()
    {
        // Invalidate the monitor before detaching the process.  A probe that is
        // already awaiting HTTP can resume after cancellation, so generation +
        // identity checks in the loop must fail before it can touch status.
        Interlocked.Increment(ref _healthGeneration);
        var healthCts = Interlocked.Exchange(ref _healthCts, null);
        try { healthCts?.Cancel(); } catch { }

        // Cancel publication when its owning server is stopped or replaced.
        lock (_syncLock)
        {
            _backgroundSyncCts?.Cancel();
        }

        var process = Interlocked.Exchange(ref _serverProcess, null);
        if (process is null) return;

        try { process.EnableRaisingEvents = false; } catch { }
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch { /* already gone */ }
        try { process.Dispose(); } catch { }
    }

    private static bool IsProcessAlive(Process process)
    {
        try { return !process.HasExited; }
        catch { return false; }
    }

    /// <summary>
    /// Check both object identity and liveness.  The port is reused during
    /// recovery, therefore a successful probe alone cannot identify which server
    /// generation answered it.
    /// </summary>
    private bool IsCurrentServerProcess(Process process)
        => ReferenceEquals(Volatile.Read(ref _serverProcess), process)
           && IsProcessAlive(process);

    private bool IsCurrentHealthLoop(
        Process process,
        string expectedBaseUrl,
        long generation,
        CancellationTokenSource cts)
        => !_stopping
           && !cts.IsCancellationRequested
           && Volatile.Read(ref _healthGeneration) == generation
           && ReferenceEquals(Volatile.Read(ref _healthCts), cts)
           && IsCurrentServerProcess(process)
           && !string.IsNullOrEmpty(expectedBaseUrl);

    /// <summary>
    /// Atomically retire one monitor.  This prevents an old loop from cancelling
    /// a replacement loop that started while the old HTTP probe was unwinding.
    /// </summary>
    private bool RetireHealthLoop(CancellationTokenSource cts, long generation)
    {
        if (Volatile.Read(ref _healthGeneration) != generation
            || !ReferenceEquals(Volatile.Read(ref _healthCts), cts))
            return false;
        if (!ReferenceEquals(Interlocked.CompareExchange(ref _healthCts, null, cts), cts))
            return false;
        Interlocked.Increment(ref _healthGeneration);
        try { cts.Cancel(); } catch { }
        return true;
    }

    private void RequestRestart(string reason)
    {
        if (_stopping) return;
        lock (_restartLock)
        {
            if (_restartTask is { IsCompleted: false }) return;
            _restartTask = RestartServerAsync(reason);
        }
    }

    private async Task RestartServerAsync(string reason)
    {
        Log($"automatic server recovery scheduled reason={reason}");
        try
        {
            for (var attempt = 1; attempt <= ServerRecoveryPolicy.MaxAttempts; attempt++)
            {
                if (_stopping) return;
                await Task.Delay(ServerRecoveryPolicy.DelayForAttempt(attempt)).ConfigureAwait(false);
                if (_stopping) return;

                Log($"automatic server recovery attempt={attempt}/{ServerRecoveryPolicy.MaxAttempts}");
                await EnsureServerRunningAsyncCore(allowRecovery: true).ConfigureAwait(false);
                if (Status == ServerStatus.Running) return;
            }

            if (!_stopping)
                Fail($"Local server recovery failed after {ServerRecoveryPolicy.MaxAttempts} attempts.");
        }
        catch (Exception ex)
        {
            Log($"automatic server recovery failed: {ex}");
            if (!_stopping) Fail($"Local server recovery failed: {ex.Message}");
        }
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

    private Process? LaunchServer(string nodePath, string entryPath)
    {
        Process? process = null;
        try
        {
            if (_stopping) return null;
            Log("LaunchServer start");
            process = StartTrackerProcess(
                nodePath, entryPath, false,
                "serve", "--port", Port.ToString(), "--no-sync", "--no-open");

            if (process is null || _stopping)
            {
                CleanupLaunchedProcess(process);
                return null;
            }

            // Publish the process before enabling Exited.  If node terminates
            // during setup, enabling events after the handler is attached will
            // deliver the callback for this exact process.
            Volatile.Write(ref _serverProcess, process);
            if (_stopping)
            {
                CleanupLaunchedProcess(process);
                return null;
            }
            Log($"server process pid={process.Id}");
            process.Exited += (_, _) => OnServerProcessExited(process);

            // Backstop: if the tray app dies abnormally, the job kills the server too.
            // Any failure after Process.Start must tear down the child; otherwise a
            // half-initialized node remains orphaned and the next recovery races it.
            _job.Assign(process.Handle);
            process.EnableRaisingEvents = true;
            if (_stopping)
            {
                CleanupLaunchedProcess(process);
                return null;
            }
            return process;
        }
        catch (Exception ex)
        {
            Log($"LaunchServer failed: {ex}");
            CleanupLaunchedProcess(process);
            if (!_stopping)
                Fail($"Failed to launch server: {ex.Message}");
            return null;
        }
    }

    private void CleanupLaunchedProcess(Process? process)
    {
        if (process is null) return;
        if (ReferenceEquals(Volatile.Read(ref _serverProcess), process))
            Interlocked.CompareExchange(ref _serverProcess, null, process);
        try { process.EnableRaisingEvents = false; } catch { }
        try
        {
            if (IsProcessAlive(process)) process.Kill(entireProcessTree: true);
        }
        catch { /* process may have exited already */ }
        try { process.Dispose(); } catch { }
    }

    private void OnServerProcessExited(Process process)
    {
        try { Log($"server process exited code={process.ExitCode}"); }
        catch { /* process may already be disposed */ }

        // A deliberate kill clears the field and disables events before terminating
        // the process, so only the still-current process can trigger recovery.
        if (_stopping
            || !ReferenceEquals(Volatile.Read(ref _serverProcess), process)
            || !ReferenceEquals(Interlocked.CompareExchange(ref _serverProcess, null, process), process))
        {
            try { process.Dispose(); } catch { }
            return;
        }

        CancelHealthLoop();
        if (_stopping)
        {
            try { process.Dispose(); } catch { }
            return;
        }
        SetStatus(ServerStatus.Starting);
        RequestRestart("server process exited unexpectedly");
        try { process.Dispose(); } catch { }
    }

    private void CancelHealthLoop()
    {
        Interlocked.Increment(ref _healthGeneration);
        var cts = Interlocked.Exchange(ref _healthCts, null);
        try { cts?.Cancel(); } catch { }
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
        // The tray host owns the five-minute background sync timer and receives
        // completion events for the UI. Disable the embedded server's own
        // one-minute fallback to avoid sync.lock contention and stale totals.
        if (!forceNativeOnlyWslMode && args.Length > 0 &&
            string.Equals(args[0], "serve", StringComparison.OrdinalIgnoreCase))
            psi.Environment["TOKENTRACKER_NATIVE_SYNC_OWNER"] = "windows-host";
        if (forceNativeOnlyWslMode)
            psi.Environment["TOKENTRACKER_WSL_MODE"] = "native-only";

        var proxySource = ChildProcessProxy.Configure(psi.Environment, HttpClient.DefaultProxy);
        if (proxySource != ChildProcessProxySource.None)
            Log($"node child proxy source={proxySource}");

        Log($"StartTrackerProcess file={nodePath} entry={entryPath} args={string.Join(" ", args)}");
        Process? proc = null;
        try
        {
            proc = Process.Start(psi);
            if (proc is null) return null;

            // Drain pipes so the child never blocks on a full stdout/stderr buffer.
            proc.OutputDataReceived += (_, e) => { if (e.Data is not null) Log($"node stdout: {e.Data}"); };
            proc.ErrorDataReceived += (_, e) => { if (e.Data is not null) Log($"node stderr: {e.Data}"); };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            return proc;
        }
        catch
        {
            // Process.Start succeeded but pipe setup failed (for example, a child
            // exited between Start and Begin*ReadLine). Do not leak that child.
            if (proc is not null)
            {
                try { proc.EnableRaisingEvents = false; } catch { }
                try { if (IsProcessAlive(proc)) proc.Kill(entireProcessTree: true); } catch { }
                try { proc.Dispose(); } catch { }
            }
            throw;
        }
    }

    // ── Health checks ──────────────────────────────────────────────────

    private async Task<bool> WaitForServerAsync(
        Process expectedProcess,
        string expectedBaseUrl,
        TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        var delayMs = 200;
        while (DateTime.UtcNow < deadline)
        {
            if (_stopping || !IsCurrentServerProcess(expectedProcess)) return false;
            // Probe the URL captured for this launch.  Port is mutable during
            // recovery; using BaseUrl here could let a response from a newer
            // process satisfy an older startup wait.
            if (await CheckHealthAsync(expectedBaseUrl).ConfigureAwait(false)
                && IsCurrentServerProcess(expectedProcess))
                return true;
            if (_stopping || !IsCurrentServerProcess(expectedProcess)) return false;
            await Task.Delay(delayMs);
            delayMs = Math.Min(delayMs * 2, 2000);
        }
        return false;
    }

    private static async Task<bool> CheckHealthAsync(string baseUrl)
    {
        try
        {
            using var resp = await Http.GetAsync(
                baseUrl + "/", HttpCompletionOption.ResponseHeadersRead);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private void StartHealthLoop(Process process, string expectedBaseUrl)
    {
        // StopServer/OnServerProcessExited can win the race after the startup
        // probe but before this monitor is installed. Do not publish a new CTS
        // for a process that is no longer current.
        if (_stopping || !IsCurrentServerProcess(process)) return;
        var cts = new CancellationTokenSource();
        var generation = Interlocked.Increment(ref _healthGeneration);
        var previous = Interlocked.Exchange(ref _healthCts, cts);
        try { previous?.Cancel(); } catch { }

        // Do not pass cts.Token to Task.Run itself: cancellation between the
        // exchange above and scheduling would otherwise skip the delegate and
        // leak this CTS without running its finally block.
        _ = Task.Run(async () =>
        {
            // Debounce: a single transient probe failure (GC pause, brief load) should not
            // flip the server to Failed — that stops the sync timer and pops a warning
            // balloon. Only declare failure after several consecutive misses.
            const int failureThreshold = 3;
            var consecutiveFailures = 0;
            try
            {
                while (IsCurrentHealthLoop(process, expectedBaseUrl, generation, cts))
                {
                    try
                    {
                        await Task.Delay(
                            TimeSpan.FromSeconds(Constants.HealthCheckIntervalSeconds),
                            cts.Token);
                    }
                    catch (TaskCanceledException) { break; }
                    if (!IsCurrentHealthLoop(process, expectedBaseUrl, generation, cts)) break;
                    if (await CheckHealthAsync(expectedBaseUrl).ConfigureAwait(false)
                        && IsCurrentHealthLoop(process, expectedBaseUrl, generation, cts))
                    {
                        consecutiveFailures = 0;
                        SetStatus(ServerStatus.Running);
                    }
                    else if (!IsCurrentHealthLoop(process, expectedBaseUrl, generation, cts))
                    {
                        break;
                    }
                    else if (++consecutiveFailures >= failureThreshold)
                    {
                        Log($"health check failed {failureThreshold} consecutive times");
                        if (!RetireHealthLoop(cts, generation)) break;
                        SetStatus(ServerStatus.Starting);
                        RequestRestart("health checks failed");
                        break;
                    }
                }
            }
            catch (Exception ex)
            {
                // A stale loop is expected to observe cancellation/teardown
                // races. Only the current generation may publish a restart.
                if (IsCurrentHealthLoop(process, expectedBaseUrl, generation, cts))
                {
                    Log($"health loop failed: {ex}");
                    if (RetireHealthLoop(cts, generation) && !_stopping)
                    {
                        SetStatus(ServerStatus.Starting);
                        RequestRestart("health loop exception");
                    }
                }
            }
            finally
            {
                try { cts.Dispose(); } catch { }
            }
        });
    }

    // ── State ──────────────────────────────────────────────────────────

    private void SetStatus(ServerStatus status)
    {
        if (Status == status) return;
        Status = status;
        if (status != ServerStatus.Failed) LastError = null;
        RaiseStatusChanged(status);
    }

    private void Fail(string message)
    {
        Log($"Fail: {message}");
        LastError = message;
        Status = ServerStatus.Failed;
        RaiseStatusChanged(ServerStatus.Failed);
    }

    // These notifications can originate from Process.Exited and health-loop
    // thread-pool callbacks.  A UI subscriber may be racing dispatcher/window
    // teardown; never let its exception escape onto the callback thread and
    // terminate the tray process.  The failure is still captured in the shared
    // diagnostic log for troubleshooting.
    private void RaiseStatusChanged(ServerStatus status)
    {
        try { StatusChanged?.Invoke(status); }
        catch (Exception ex) { Log($"StatusChanged handler failed: {ex}"); }
    }

    private void RaiseSyncStarted()
    {
        try { SyncStarted?.Invoke(); }
        catch (Exception ex) { Log($"SyncStarted handler failed: {ex}"); }
    }

    private void RaiseSyncCompleted()
    {
        try { SyncCompleted?.Invoke(); }
        catch (Exception ex) { Log($"SyncCompleted handler failed: {ex}"); }
    }

    private static void Log(string message) => Diag.Log("server", message);

    public void Dispose()
    {
        StopServer();
        _job.Dispose();
    }
}
