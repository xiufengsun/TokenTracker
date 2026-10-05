using System.Net;
using System.Net.Sockets;
using System.Text;
using Xunit;

namespace TokenTrackerWin.Tests;

/// <summary>
/// The tray/pet poller asks the local server for the cross-device ("account")
/// aggregate. That server answers with this-machine data both when that really is
/// the user's scope and when a cloud read merely failed, so the poller has to tell
/// the two apart or one timed-out request silently drops the tray to a single
/// machine. These drive the real <see cref="UsagePoller"/> against a loopback
/// server that serves the headers under test.
/// </summary>
public sealed class UsagePollerAccountAuthorityTests
{
    private const string SummaryPath = "/functions/tokentracker-usage-summary";
    private const string HeatmapPath = "/functions/tokentracker-usage-heatmap";
    private const string ModelsPath = "/functions/tokentracker-usage-model-breakdown";
    private const string LimitsPath = "/functions/tokentracker-usage-limits";

    /// <summary>Headers a response carries: null = the account view was served.</summary>
    private sealed record Authority(string View, string? Fallback)
    {
        public static readonly Authority Account = new("1", null);
        public static readonly Authority SignedOut = new("0", "signed-out");
        public static readonly Authority Transient = new("0", "transient-network");
    }

    /// <summary>
    /// A loopback HTTP/1.1 server built on a raw socket rather than HttpListener:
    /// HttpListener goes through HTTP.sys on Windows, where registering a prefix
    /// can need an URL ACL or elevation. A TcpListener has no such requirement,
    /// so this behaves the same on every runner.
    /// </summary>
    private sealed class FakeLocalServer : IDisposable
    {
        private readonly TcpListener _listener;
        private readonly CancellationTokenSource _stop = new();

        public string BaseUrl { get; }
        public Authority SummaryAuthority = Authority.Account;
        public Authority HeatmapAuthority = Authority.Account;
        public Authority ModelsAuthority = Authority.Account;
        public long SummaryTokens = 1_000;
        public int HeatmapStreak = 7;
        public bool FailLimits;
        public readonly System.Collections.Concurrent.ConcurrentQueue<string> Requests = new();

        public FakeLocalServer()
        {
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            BaseUrl = $"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}";
            _ = Task.Run(AcceptLoopAsync);
        }

        private async Task AcceptLoopAsync()
        {
            while (!_stop.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await _listener.AcceptTcpClientAsync(_stop.Token); }
                catch { return; }
                _ = Task.Run(() => ServeOneAsync(client));
            }
        }

        private async Task ServeOneAsync(TcpClient client)
        {
            using (client)
            {
                try
                {
                    using var stream = client.GetStream();
                    var path = await ReadRequestPathAsync(stream);
                    var (authority, body) = path switch
                    {
                        SummaryPath => (SummaryAuthority, SummaryJson()),
                        HeatmapPath => (HeatmapAuthority,
                            "{\"streak_days\":" + HeatmapStreak + ",\"active_days\":42}"),
                        ModelsPath => (ModelsAuthority, ModelsJson()),
                        _ => (Authority.Account, "{}"),
                    };

                    var payload = Encoding.UTF8.GetBytes(body);
                    var head = new StringBuilder()
                        .Append(path == LimitsPath && FailLimits ? "HTTP/1.1 503 Unavailable\r\n" : "HTTP/1.1 200 OK\r\n")
                        .Append("Content-Type: application/json\r\n")
                        .Append("Content-Length: ").Append(payload.Length).Append("\r\n")
                        .Append("X-TokenTracker-Account-View: ").Append(authority.View).Append("\r\n");
                    if (authority.Fallback is not null)
                        head.Append("X-TokenTracker-Account-Fallback: ").Append(authority.Fallback).Append("\r\n");
                    // One request per connection keeps the parsing above trivial.
                    head.Append("Connection: close\r\n\r\n");

                    await stream.WriteAsync(Encoding.ASCII.GetBytes(head.ToString()));
                    await stream.WriteAsync(payload);
                    await stream.FlushAsync();
                }
                catch
                {
                    // A client that hung up mid-response is not a test failure.
                }
            }
        }

        /// <summary>Reads just enough of the request to route it: the path from the request line.</summary>
        private async Task<string> ReadRequestPathAsync(NetworkStream stream)
        {
            var buffer = new byte[4096];
            var read = 0;
            while (read < buffer.Length)
            {
                var n = await stream.ReadAsync(buffer.AsMemory(read, buffer.Length - read));
                if (n == 0) break;
                read += n;
                var soFar = Encoding.ASCII.GetString(buffer, 0, read);
                if (soFar.Contains("\r\n\r\n")) break;
            }

            var requestLine = Encoding.ASCII.GetString(buffer, 0, read).Split("\r\n")[0];
            var target = requestLine.Split(' ') is [_, var t, ..] ? t : "";
            Requests.Enqueue(target);
            var query = target.IndexOf('?');
            return query >= 0 ? target[..query] : target;
        }

        private string SummaryJson() =>
            "{\"totals\":{\"total_tokens\":" + SummaryTokens
            + ",\"conversation_count\":3,\"total_cost_usd\":\"1.25\"},"
            + "\"rolling\":{\"last_7d\":{\"active_days\":4,\"totals\":{\"total_tokens\":900}},"
            + "\"last_30d\":{\"avg_per_active_day\":50,\"totals\":{\"total_tokens\":9000}}}}";

        private static string ModelsJson() =>
            """
            {"sources":[{"source":"claude","models":[{"model":"opus","totals":{"total_tokens":500}}]}]}
            """;

        public void Dispose()
        {
            _stop.Cancel();
            try { _listener.Stop(); } catch { }
            _stop.Dispose();
        }
    }

    /// <summary>Runs one poll; returns the published stats, or null if none was published.</summary>
    private static async Task<UsagePoller.UsageStats?> PollOnceAsync(UsagePoller poller, TimeSpan wait, bool forceAccount = true)
    {
        var published = new TaskCompletionSource<UsagePoller.UsageStats>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        void OnStats(UsagePoller.UsageStats s) => published.TrySetResult(s);
        poller.StatsUpdated += OnStats;
        try
        {
            poller.RefreshNow(forceAccount);
            var done = await Task.WhenAny(published.Task, Task.Delay(wait));
            return done == published.Task ? published.Task.Result : null;
        }
        finally
        {
            poller.StatsUpdated -= OnStats;
        }
    }

    private static readonly TimeSpan Publishes = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task OrdinaryPollsKeepLocalAndLimitsReadsWhileManualRefreshBypassesAccountCache()
    {
        using var server = new FakeLocalServer();
        using var poller = new UsagePoller(() => server.BaseUrl)
        {
            IncludeRichStats = true,
            IncludeLimits = true,
        };
        var first = await PollOnceAsync(poller, Publishes, forceAccount: false);
        Assert.NotNull(first);
        var ordinary = server.Requests.ToArray();
        Assert.Contains(ordinary, request => request.StartsWith(SummaryPath));
        Assert.Contains(ordinary, request => request.StartsWith(HeatmapPath));
        Assert.Contains(ordinary, request => request.StartsWith(ModelsPath));
        Assert.Contains(LimitsPath, ordinary);
        Assert.All(ordinary, request => Assert.DoesNotContain("refresh=1", request));

        server.SummaryTokens = 2_000;
        var refreshed = await PollOnceAsync(poller, Publishes);
        Assert.NotNull(refreshed);
        Assert.Equal(2_000, refreshed.Value.TodayTokens);
        var manual = server.Requests.ToArray().Skip(ordinary.Length).ToArray();
        foreach (var path in new[] { SummaryPath, HeatmapPath, ModelsPath })
            Assert.Contains(manual, request => request.StartsWith(path) && request.Contains("refresh=1"));
        Assert.Contains(LimitsPath, manual);
    }

    [Fact]
    public async Task QuotaFailureIsReportedAndTheNextRefreshRecovers()
    {
        using var server = new FakeLocalServer { FailLimits = true };
        using var poller = new UsagePoller(() => server.BaseUrl) { IncludeLimits = true };
        var failed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var recovered = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        poller.LimitsFailed += () => failed.TrySetResult(true);
        poller.LimitsUpdated += json => recovered.TrySetResult(json);
        poller.RefreshNow();
        await failed.Task.WaitAsync(Publishes);
        Assert.False(recovered.Task.IsCompleted);
        server.FailLimits = false;
        poller.RefreshNow();
        Assert.Equal("{}", await recovered.Task.WaitAsync(Publishes));
    }
    // Long enough for the poll to finish and decide not to publish.
    private static readonly TimeSpan NoPublish = TimeSpan.FromSeconds(3);

    [Fact]
    public async Task RichStatFallbackIsNotMixedIntoTheFirstAccountSnapshot()
    {
        // The transition the tray actually starts in: nothing published yet, so
        // the "are we showing account data" flag is still false. A guard written
        // against that flag alone lets this machine's streak ride along inside an
        // otherwise cross-device snapshot — and because the next poll then sees
        // the flag as true and skips publishing, that mixed snapshot stays on the
        // tray until the heatmap recovers.
        using var server = new FakeLocalServer
        {
            SummaryAuthority = Authority.Account,
            HeatmapAuthority = Authority.Transient,
        };
        using var poller = new UsagePoller(() => server.BaseUrl) { IncludeRichStats = true, IncludeLimits = false };

        var stats = await PollOnceAsync(poller, NoPublish);

        Assert.Null(stats);
    }

    [Fact]
    public async Task AnAllAccountPollPublishes()
    {
        // Control for the test above: the guard must not simply block everything.
        using var server = new FakeLocalServer();
        using var poller = new UsagePoller(() => server.BaseUrl) { IncludeRichStats = true, IncludeLimits = false };

        var stats = await PollOnceAsync(poller, Publishes);

        Assert.NotNull(stats);
        Assert.Equal(1_000, stats!.Value.TodayTokens);
        Assert.Equal(7, stats.Value.StreakDays);
    }

    [Fact]
    public async Task ATransientSummaryNeverReplacesAccountFiguresAlreadyShown()
    {
        using var server = new FakeLocalServer();
        using var poller = new UsagePoller(() => server.BaseUrl) { IncludeRichStats = true, IncludeLimits = false };

        var first = await PollOnceAsync(poller, Publishes);
        Assert.NotNull(first);

        server.SummaryAuthority = Authority.Transient;
        server.SummaryTokens = 12; // this machine only — must not reach the tray
        var second = await PollOnceAsync(poller, NoPublish);

        Assert.Null(second);
    }

    [Fact]
    public async Task SigningOutStillSwitchesTheTrayToLocalData()
    {
        // The reverse invariant: an authoritative local view must always win, or a
        // signed-out user keeps staring at another session's totals.
        using var server = new FakeLocalServer();
        using var poller = new UsagePoller(() => server.BaseUrl) { IncludeRichStats = true, IncludeLimits = false };

        Assert.NotNull(await PollOnceAsync(poller, Publishes));

        server.SummaryAuthority = Authority.SignedOut;
        server.HeatmapAuthority = Authority.SignedOut;
        server.ModelsAuthority = Authority.SignedOut;
        server.SummaryTokens = 12;
        var afterSignOut = await PollOnceAsync(poller, Publishes);

        Assert.NotNull(afterSignOut);
        Assert.Equal(12, afterSignOut!.Value.TodayTokens);
    }

    [Fact]
    public async Task AServerTooOldToSendTheReasonHeaderKeepsPreFixBehaviour()
    {
        using var server = new FakeLocalServer();
        using var poller = new UsagePoller(() => server.BaseUrl) { IncludeRichStats = true, IncludeLimits = false };

        Assert.NotNull(await PollOnceAsync(poller, Publishes));

        // No fallback header at all: authoritative-local, so it publishes.
        server.SummaryAuthority = new Authority("0", null);
        server.HeatmapAuthority = new Authority("0", null);
        server.ModelsAuthority = new Authority("0", null);
        server.SummaryTokens = 12;
        var stats = await PollOnceAsync(poller, Publishes);

        Assert.NotNull(stats);
        Assert.Equal(12, stats!.Value.TodayTokens);
    }
}
