using System.Globalization;
using System.Net.Http;
using System.Text.Json;

namespace TokenTrackerWin;

/// <summary>
/// Polls the local server's usage endpoints for the figures the tray + floating pet
/// surface. The tray only needs today's totals ("Today &lt;tokens&gt; · &lt;cost&gt;"),
/// but the desktop pet mirrors the macOS companion's data-rich quip pool, so when the
/// pet is visible the poller also gathers the rolling / heatmap / top-model stats the
/// macOS <c>DashboardViewModel</c> feeds its <c>quipPool</c>.
///
/// The 7-day / 30-day rolling stats + today's conversation count come <b>free</b> from
/// the same usage-summary call the tray already makes (the endpoint returns a
/// <c>rolling</c> block). The heatmap (all-time active days) and model breakdown (top
/// models) need their own calls, so they are gated behind <see cref="IncludeRichStats"/>
/// — only fetched while the pet is on screen, never wasted when it's hidden.
/// </summary>
internal sealed class UsagePoller : IDisposable
{
    /// <summary>One of the pet's "top models" (name + share + provider), mirroring macOS TopModel.</summary>
    public readonly record struct TopModelStat(string Name, string Percent, string Source);

    public readonly record struct UsageStats(
        long TodayTokens,
        decimal TodayCostUsd,
        int TodayConversations,
        long Last7dTokens,
        int Last7dActiveDays,
        long Last30dTokens,
        long Last30dAvgPerDay,
        int StreakDays,
        int ActiveDaysAllTime,
        IReadOnlyList<TopModelStat> TopModels);

    // Local server only (127.0.0.1) — never route through a system/env proxy, or a
    // VPN/proxy user without a loopback bypass can't reach it (see ServerManager.Http).
    private static readonly HttpClient Http =
        new(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(6) };
    private static readonly IReadOnlyList<TopModelStat> NoModels = Array.Empty<TopModelStat>();
    // Cross-device ("account") aggregate request flag; the local server decides
    // whether to serve it (signed in + cloud sync on) or local data, keeping the
    // tray/pet figures aligned with the dashboard. Joined with an explicit '&'.
    private const string AccountQuery = "account=1";
    private readonly Func<string> _baseUrl;
    private CancellationTokenSource? _cts;
    private int _refreshInFlight;
    private int _refreshRequested;
    /// <summary>
    /// Whether the figures currently on the tray/pet came from the cross-device
    /// account aggregate. Guards against a temporary cloud failure replacing them
    /// with this-machine data; see <see cref="ReadAccountSource"/>.
    /// </summary>
    private volatile bool _showingAccountData;

    // `streak_days` and `active_days` are day-grained — they change at most once
    // a day — but they arrive inside a 52-week grid that is by far the largest
    // response the tray pulls (~40 KB). Re-reading it on every 60-second tick
    // spent the bulk of the backend's egress budget re-learning two integers.
    // Holding the pair for five minutes is invisible to the pet's quip pool.
    // Keyed by (timezone, account-authority) so signing out, or a cloud
    // downgrade, drops the cached pair instead of showing stale cross-device
    // figures.
    private static readonly TimeSpan HeatmapTtl = TimeSpan.FromMinutes(5);
    private string _heatmapCacheKey = string.Empty;
    private (int Streak, int ActiveDays) _heatmapCacheValue;
    private DateTime _heatmapCachedUtc = DateTime.MinValue;

    /// <summary>
    /// When true, each poll also gathers the heatmap + model-breakdown stats the pet's
    /// quip pool uses (two extra calls). The tray sets this from the pet's visibility so
    /// the extra work only happens while the pet is on screen.
    /// </summary>
    public volatile bool IncludeRichStats;

    /// <summary>
    /// Fetch the provider quota snapshot while the desktop pet is visible. Keeping
    /// this behind the same visibility gate as rich stats avoids waking provider
    /// credential readers when the pet is hidden.
    /// </summary>
    public volatile bool IncludeLimits;

    /// <summary>Raised on the thread-pool with fresh stats. UI must marshal to the UI thread.</summary>
    public event Action<UsageStats>? StatsUpdated;

    /// <summary>Raised with the raw local usage-limits JSON so each pet client can select its own display line.</summary>
    public event Action<string>? LimitsUpdated;

    public UsagePoller(Func<string> baseUrl) => _baseUrl = baseUrl;

    public void Start()
    {
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        var token = _cts.Token;
        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    await RefreshAsync(token);
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    // A subscriber or an unexpected parser failure must not
                    // terminate the long-lived polling loop.  The next tick
                    // can still recover and publish fresh usage.
                    Log($"refresh loop failed: {ex}");
                }
                try { await Task.Delay(TimeSpan.FromSeconds(60), token); }
                catch (TaskCanceledException) { break; }
            }
        }, token);
    }

    public void RefreshNow()
    {
        var token = _cts?.Token ?? CancellationToken.None;
        // Do not pass the token to Task.Run itself. A manual refresh can be
        // requested just as Start() replaces the CTS; scheduling with the old
        // (already-cancelled) token would cause the delegate to be discarded
        // before RefreshAsync gets a chance to drain the request.
        _ = Task.Run(() => RefreshAsync(token));
    }

    /// <summary>
    /// Coalesce timer, sync-completion, and manual refresh requests. Without a
    /// single-flight gate, a slow account-view request can leave several reads
    /// in flight and allow an older response to overwrite newer totals.
    /// </summary>
    private async Task RefreshAsync(CancellationToken token)
    {
        Interlocked.Exchange(ref _refreshRequested, 1);
        if (Interlocked.CompareExchange(ref _refreshInFlight, 1, 0) != 0) return;

        try
        {
            while (!token.IsCancellationRequested &&
                   Interlocked.Exchange(ref _refreshRequested, 0) == 1)
            {
                // Limits are independent of the usage summary. Start both
                // requests together so a slow provider quota reader cannot add
                // another full network round-trip to the visible refresh.
                var includeLimits = IncludeLimits;
                var statsTask = FetchAsync(token);
                var limitsTask = includeLimits ? FetchLimitsAsync(token) : null;
                var stats = await statsTask;
                if (stats is { } s && !token.IsCancellationRequested) RaiseStatsUpdated(s);
                if (includeLimits && limitsTask is not null)
                {
                    var limits = await limitsTask;
                    if (limits is not null && !token.IsCancellationRequested) RaiseLimitsUpdated(limits);
                }
            }
        }
        finally
        {
            Interlocked.Exchange(ref _refreshInFlight, 0);
            // Drain a request that arrived between the loop's final check and
            // releasing the gate without building an unbounded task chain.
            // Use the current poller's token: Start() can replace a cancelled
            // poll loop while its final request is still unwinding.
            var currentToken = _cts?.Token ?? token;
            if (Volatile.Read(ref _refreshRequested) == 1 && !currentToken.IsCancellationRequested)
            {
                // Keep the cancellation token inside RefreshAsync rather than
                // passing it to Task.Run.  The token can be cancelled in the
                // tiny window between the check above and queueing the work;
                // Task.Run would then discard the delegate and leave
                // _refreshRequested set forever, so the next refresh would be
                // silently lost until another external trigger arrives.
                _ = Task.Run(() => RefreshAsync(currentToken));
            }
        }
    }

    private async Task<string?> FetchLimitsAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            using var resp = await Http.GetAsync(
                _baseUrl() + "/functions/tokentracker-usage-limits", cancellationToken);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content.ReadAsStringAsync(cancellationToken);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Why the local server served what it served on an <c>account=1</c> request.</summary>
    private enum AccountSource
    {
        /// <summary>Cross-device account aggregate.</summary>
        Account,
        /// <summary>This-machine data, and that is the correct scope (signed out / cloud sync off).</summary>
        LocalAuthoritative,
        /// <summary>This-machine data only because the cloud read failed.</summary>
        LocalTransient,
    }

    /// <summary>
    /// Read the pair of account-view headers. A server too old to send the reason
    /// header reports no reason, which stays <see cref="AccountSource.LocalAuthoritative"/>.
    /// </summary>
    private static AccountSource ReadAccountSource(HttpResponseMessage resp)
    {
        if (resp.Headers.TryGetValues("X-TokenTracker-Account-View", out var view)
            && view.FirstOrDefault() == "1")
            return AccountSource.Account;

        var reason = resp.Headers.TryGetValues("X-TokenTracker-Account-Fallback", out var fallback)
            ? fallback.FirstOrDefault() ?? string.Empty
            : string.Empty;
        return reason.StartsWith("transient", StringComparison.Ordinal)
            ? AccountSource.LocalTransient
            : AccountSource.LocalAuthoritative;
    }

    private async Task<UsageStats?> FetchAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            var today = DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var tzQuery = TimeZoneQuery();

            // account=1 → the server serves the same cross-device aggregate the
            // dashboard shows when the user is signed in with cloud sync on, and
            // otherwise falls back to local single-machine data. Same response
            // schema either way, so parsing below is unchanged.
            var summaryUrl = $"{_baseUrl()}/functions/tokentracker-usage-summary"
                             + $"?from={today}&to={today}{tzQuery}&{AccountQuery}";

            using var resp = await Http.GetAsync(summaryUrl, cancellationToken);
            if (!resp.IsSuccessStatusCode) return null;

            // A transient cloud failure must not replace an already-visible
            // cross-device snapshot with this-machine data.
            var summarySource = ReadAccountSource(resp);
            if (summarySource == AccountSource.LocalTransient && _showingAccountData) return null;

            await using var stream = await resp.Content.ReadAsStreamAsync(cancellationToken);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            var root = doc.RootElement;
            if (!root.TryGetProperty("totals", out var totals)) return null;

            long tokens = ResolveDisplayTokens(totals);
            int convos = (int)GetLong(totals, "conversation_count");
            decimal cost = 0m;
            if (totals.TryGetProperty("total_cost_usd", out var c)
                && decimal.TryParse(c.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed))
                cost = parsed;

            // 7-day / 30-day rolling stats ride along in the same response — no extra call.
            long l7Tokens = 0, l30Tokens = 0, l30Avg = 0;
            int l7Active = 0;
            if (root.TryGetProperty("rolling", out var rolling))
            {
                if (rolling.TryGetProperty("last_7d", out var l7))
                {
                    l7Active = (int)GetLong(l7, "active_days");
                    if (l7.TryGetProperty("totals", out var l7t)) l7Tokens = ResolveDisplayTokens(l7t);
                }
                if (rolling.TryGetProperty("last_30d", out var l30))
                {
                    l30Avg = GetLong(l30, "avg_per_active_day");
                    if (l30.TryGetProperty("totals", out var l30t)) l30Tokens = ResolveDisplayTokens(l30t);
                }
            }

            // Heatmap (all-time active days / streak) + top models only when the pet wants them.
            int streak = 0, activeAll = 0;
            IReadOnlyList<TopModelStat> models = NoModels;
            if (IncludeRichStats)
            {
                // These two endpoints are independent. Fetching them in
                // parallel cuts the rich-refresh tail from roughly 2× the HTTP
                // timeout to a single timeout window when the backend is slow.
                // Guard each dataset using the authority of this poll, not only
                // the previously published one, so a cold account snapshot
                // cannot be mixed with transient local rich stats.
                var retainAccount = summarySource == AccountSource.Account || _showingAccountData;
                var heatmapTask = FetchHeatmapAsync(tzQuery, retainAccount, cancellationToken);
                var modelsTask = FetchTopModelsAsync(today, tzQuery, retainAccount, cancellationToken);
                await Task.WhenAll(heatmapTask, modelsTask);
                var heatmap = await heatmapTask;
                var topModels = await modelsTask;
                if (heatmap is null || topModels is null) return null;
                (streak, activeAll) = heatmap.Value;
                models = topModels;
            }

            _showingAccountData = summarySource == AccountSource.Account;
            return new UsageStats(
                tokens, cost, convos,
                l7Tokens, l7Active,
                l30Tokens, l30Avg,
                streak, activeAll,
                models);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Heatmap: all-time active days + current streak (streak is server-computed; the
    /// local server returns 0, matching how the macOS pet reads it against the same backend).</summary>
    private async Task<(int Streak, int ActiveDays)?> FetchHeatmapAsync(
        string tzQuery, bool retainAccount, CancellationToken cancellationToken = default)
    {
        var cacheKey = $"{tzQuery}|{retainAccount}";
        if (_heatmapCacheKey == cacheKey && DateTime.UtcNow - _heatmapCachedUtc < HeatmapTtl)
        {
            return _heatmapCacheValue;
        }

        try
        {
            var url = $"{_baseUrl()}/functions/tokentracker-usage-heatmap?weeks=52{tzQuery}&{AccountQuery}";
            using var resp = await Http.GetAsync(url, cancellationToken);
            if (!resp.IsSuccessStatusCode) return (0, 0);
            if (ReadAccountSource(resp) == AccountSource.LocalTransient && retainAccount) return null;
            await using var stream = await resp.Content.ReadAsStreamAsync(cancellationToken);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            var root = doc.RootElement;
            var parsed = ((int)GetLong(root, "streak_days"), (int)GetLong(root, "active_days"));
            _heatmapCacheValue = parsed;
            _heatmapCacheKey = cacheKey;
            _heatmapCachedUtc = DateTime.UtcNow;
            return parsed;
        }
        catch { return (0, 0); }
    }

    /// <summary>
    /// Top models over the last 30 days — a faithful port of the macOS
    /// <c>DashboardViewModel.buildTopModels()</c>: dedupe by lowercased model name, keep the
    /// provider from the highest-token row for that name, percent = tokens / total billable
    /// (one decimal), sort by tokens desc then name asc, top 5.
    /// </summary>
    private async Task<IReadOnlyList<TopModelStat>?> FetchTopModelsAsync(
        string today, string tzQuery, bool retainAccount, CancellationToken cancellationToken = default)
    {
        try
        {
            var from = DateTime.Now.AddDays(-29).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var url = $"{_baseUrl()}/functions/tokentracker-usage-model-breakdown"
                      + $"?from={from}&to={today}{tzQuery}&{AccountQuery}";
            using var resp = await Http.GetAsync(url, cancellationToken);
            if (!resp.IsSuccessStatusCode) return NoModels;
            if (ReadAccountSource(resp) == AccountSource.LocalTransient && retainAccount) return null;
            await using var stream = await resp.Content.ReadAsStreamAsync(cancellationToken);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            if (!doc.RootElement.TryGetProperty("sources", out var sources)
                || sources.ValueKind != JsonValueKind.Array) return NoModels;

            var tokensByKey = new Dictionary<string, long>();
            var nameByKey = new Dictionary<string, string>();
            var sourceByKey = new Dictionary<string, string>();
            var weightByKey = new Dictionary<string, long>();
            long totalTokensAll = 0;

            foreach (var src in sources.EnumerateArray())
            {
                var srcName = src.TryGetProperty("source", out var sn) ? sn.GetString() ?? "" : "";
                if (!src.TryGetProperty("models", out var modelsEl) || modelsEl.ValueKind != JsonValueKind.Array)
                    continue;
                foreach (var m in modelsEl.EnumerateArray())
                {
                    long mt = m.TryGetProperty("totals", out var mtotals) ? ResolveDisplayTokens(mtotals) : 0;
                    if (mt <= 0) continue;
                    var name = m.TryGetProperty("model", out var mn) ? mn.GetString() ?? "" : "";
                    if (string.IsNullOrEmpty(name)) name = "—";
                    var key = name.ToLowerInvariant().Trim();
                    if (key.Length == 0) continue;

                    totalTokensAll += mt;
                    tokensByKey[key] = tokensByKey.GetValueOrDefault(key) + mt;
                    if (mt >= weightByKey.GetValueOrDefault(key))
                    {
                        weightByKey[key] = mt;
                        nameByKey[key] = name;
                        sourceByKey[key] = srcName;
                    }
                }
            }

            if (tokensByKey.Count == 0) return NoModels;
            long totalTokens = totalTokensAll > 0 ? totalTokensAll : tokensByKey.Values.Sum();

            return tokensByKey
                .Select(kv => new
                {
                    Tokens = kv.Value,
                    Stat = new TopModelStat(
                        nameByKey.GetValueOrDefault(kv.Key, "—"),
                        totalTokens > 0
                            ? (kv.Value / (double)totalTokens * 100).ToString("0.0", CultureInfo.InvariantCulture)
                            : "0.0",
                        sourceByKey.GetValueOrDefault(kv.Key, "")),
                })
                .OrderByDescending(x => x.Tokens)
                .ThenBy(x => x.Stat.Name, StringComparer.Ordinal)
                .Take(5)
                .Select(x => x.Stat)
                .ToList();
        }
        catch { return NoModels; }
    }

    /// <summary>
    /// Match the dashboard's resolveDisplayTokens semantics: prefer a positive
    /// billable total, otherwise fall back to a positive raw total. Keeping this
    /// policy here prevents the Windows tray/pet from disagreeing with the same
    /// usage-summary response rendered in the Dashboard.
    /// </summary>
    internal static long ResolveDisplayTokens(JsonElement totals)
    {
        var hasBillable = TryGetLong(totals, "billable_total_tokens", out var billable);
        var hasTotal = TryGetLong(totals, "total_tokens", out var total);
        if (hasBillable && billable > 0) return billable;
        if (hasTotal && total > 0) return total;
        if (hasBillable) return billable;
        if (hasTotal) return total;
        return 0;
    }

    private static bool TryGetLong(JsonElement obj, string name, out long value)
    {
        value = 0;
        if (!obj.TryGetProperty(name, out var el)) return false;
        switch (el.ValueKind)
        {
            case JsonValueKind.Number:
                value = el.TryGetInt64(out var numeric) ? numeric : (long)el.GetDouble();
                return true;
            case JsonValueKind.String:
                return long.TryParse(
                    el.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out value);
            default:
                return false;
        }
    }

    private static long GetLong(JsonElement obj, string name)
    {
        return TryGetLong(obj, name, out var value) ? value : 0;
    }

    // Polling callbacks cross from the worker thread into WinForms/WPF. A
    // window can close between scheduling and dispatch, so subscriber failures
    // are diagnostic-only and must never stop future refreshes.
    private void RaiseStatsUpdated(UsageStats stats)
    {
        try { StatsUpdated?.Invoke(stats); }
        catch (Exception ex) { Log($"StatsUpdated handler failed: {ex}"); }
    }

    private void RaiseLimitsUpdated(string limitsJson)
    {
        try { LimitsUpdated?.Invoke(limitsJson); }
        catch (Exception ex) { Log($"LimitsUpdated handler failed: {ex}"); }
    }

    private static void Log(string message) => Diag.Log("poller", message);

    /// <summary>The usage endpoints expect an IANA tz; Windows uses its own ids, so convert.</summary>
    private static string TimeZoneQuery()
    {
        var offsetMin = (int)DateTimeOffset.Now.Offset.TotalMinutes;
        var tz = ResolveIanaTimeZone();
        return $"&tz={Uri.EscapeDataString(tz)}&tz_offset_minutes={offsetMin}";
    }

    private static string ResolveIanaTimeZone()
    {
        try
        {
            if (TimeZoneInfo.TryConvertWindowsIdToIanaId(TimeZoneInfo.Local.Id, out var iana))
                return iana;
        }
        catch { /* fall back below */ }
        return "UTC";
    }

    public void Dispose()
    {
        _cts?.Cancel();
        _cts = null;
    }

    // ── Formatting (mirrors macOS TokenFormatter.formatCompact + cost) ──

    public static string FormatTokens(long n)
    {
        if (n >= 1_000_000_000) return (n / 1_000_000_000d).ToString("0.0", CultureInfo.InvariantCulture) + "B";
        if (n >= 1_000_000) return (n / 1_000_000d).ToString("0.0", CultureInfo.InvariantCulture) + "M";
        if (n >= 1_000) return (n / 1_000d).ToString("0.0", CultureInfo.InvariantCulture) + "K";
        return n.ToString(CultureInfo.InvariantCulture);
    }

    public static string FormatCost(decimal usd) =>
        "$" + usd.ToString("0.00", CultureInfo.InvariantCulture);
}
