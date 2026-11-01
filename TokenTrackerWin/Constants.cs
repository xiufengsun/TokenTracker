namespace TokenTrackerWin;

/// <summary>
/// Mirror of <c>TokenTrackerBar/Utilities/Constants.swift</c>. The local server
/// port and dashboard URL must match the CLI (<c>tracker serve</c> binds :7680).
/// </summary>
internal static class Constants
{
    // The live server URL is owned by ServerManager — it picks a free loopback
    // port at launch (the CLI default 7680 is unreliable on Windows: Delivery
    // Optimization holds it). Always IPv4 ("127.0.0.1"), never "localhost",
    // which would resolve to ::1 and hit DoSvc on 7680.

    /// <summary>Poll interval for the background health-check loop.</summary>
    public const int HealthCheckIntervalSeconds = 30;

    /// <summary>
    /// How long to wait for the server to answer after launch.
    /// Must clear first-run <c>tracker serve</c> init + first sync before the
    /// HTTP listener binds (see issue #961): init alone can spend ~6s on
    /// config plus up to FIRST_SYNC_TIMEOUT_MS (15s) waiting on sync, so a
    /// 20s host deadline races the bind and kills the child mid-setup.
    /// </summary>
    public const int StartupTimeoutSeconds = 90;

    public const string AppDisplayName = "TokenTracker";
    public const string GitHubUrl = "https://github.com/xiufengsun/TokenTracker";

    /// <summary>HKCU Run-key value name used for launch-at-startup.</summary>
    public const string StartupRegistryValueName = "TokenTracker";
}
