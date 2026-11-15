using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using TokenTrackerWin;
using Xunit;

namespace TokenTrackerWin.Tests;

public sealed class UpdateReleaseClientTests
{
    private const string ApiUrl = "https://api.github.com/repos/xiufengsun/TokenTracker/releases/latest";
    private const string TagUrl = "https://github.com/xiufengsun/TokenTracker/releases/tag/v1.3.9";
    private const string AssetBase = "https://github.com/xiufengsun/TokenTracker/releases/download/v1.3.9/";
    private static readonly DateTimeOffset Now = new(2026, 10, 12, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task SuccessfulApiDoesNotUseReleasePage()
    {
        var calls = new List<string>();
        using var http = Http(request => { calls.Add(request.RequestUri!.AbsoluteUri); return ApiRelease(); });
        var resolver = new UpdateReleaseClient(http);

        var release = await resolver.FetchLatestAsync();

        Assert.Equal("1.3.9", release.Version);
        Assert.Equal(900, release.SetupSize);
        Assert.Equal(AssetBase + "TokenTracker-Setup.exe", release.SetupUrl);
        Assert.Equal(AssetBase + "SHA256SUMS", release.ChecksumsUrl);
        Assert.Equal([ApiUrl], calls);
        Assert.False(resolver.UsedFallback);
        Assert.Null(resolver.ApiRetryAt);
    }

    [Fact]
    public async Task PrimaryLimitFallsBackAndPinsInstallerAndChecksumToOneTag()
    {
        var calls = new List<(HttpMethod Method, string Url)>();
        using var http = Http(request =>
        {
            calls.Add((request.Method, request.RequestUri!.AbsoluteUri));
            return IsApi(request) ? RateLimited(reset: Now.AddHours(1)) : ReleasePageResponse(request);
        });
        var resolver = new UpdateReleaseClient(http, () => Now);

        var release = await resolver.FetchLatestAsync();

        Assert.True(resolver.UsedFallback);
        Assert.Equal(Now.AddHours(1), resolver.ApiRetryAt);
        Assert.Equal(900, release.SetupSize);
        Assert.Equal(AssetBase + "TokenTracker-Setup.exe", release.SetupUrl);
        Assert.Equal(AssetBase + "SHA256SUMS", release.ChecksumsUrl);
        Assert.Equal(new[] {
            (HttpMethod.Get, ApiUrl),
            (HttpMethod.Head, UpdateReleaseClient.ReleasePageUrl),
            (HttpMethod.Head, release.SetupUrl),
            (HttpMethod.Get, release.ChecksumsUrl!),
        }, calls);
    }

    [Fact]
    public async Task CooldownSkipsApiUntilResetThenReturnsToApi()
    {
        var now = Now;
        var apiCalls = 0;
        using var http = Http(request => !IsApi(request) ? ReleasePageResponse(request)
            : ++apiCalls == 1 ? RateLimited(reset: Now.AddHours(1)) : ApiRelease());
        var resolver = new UpdateReleaseClient(http, () => now);

        await resolver.FetchLatestAsync();
        now = Now.AddMinutes(59);
        await resolver.FetchLatestAsync();
        Assert.Equal(1, apiCalls);
        Assert.True(resolver.UsedFallback);
        now = Now.AddHours(1);
        await resolver.FetchLatestAsync();
        Assert.Equal(2, apiCalls);
        Assert.False(resolver.UsedFallback);
        Assert.Null(resolver.ApiRetryAt);
    }

    [Theory]
    [InlineData(403)]
    [InlineData(429)]
    public async Task LimitWithoutTimeWaitsOneMinuteWithoutInventingDisplayedTime(int status)
    {
        var now = Now;
        var apiCalls = 0;
        using var http = Http(request =>
        {
            if (!IsApi(request)) return ReleasePageResponse(request);
            apiCalls++;
            return new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent("API rate limit exceeded") };
        });
        var resolver = new UpdateReleaseClient(http, () => now);

        await resolver.FetchLatestAsync();
        Assert.Null(resolver.ApiRetryAt);
        now = Now.AddSeconds(59);
        await resolver.FetchLatestAsync();
        Assert.Equal(1, apiCalls);
        now = Now.AddMinutes(1);
        await resolver.FetchLatestAsync();
        Assert.Equal(2, apiCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SecondaryLimitHonorsRetryAfterDeltaOrDate(bool absolute)
    {
        using var http = Http(request =>
        {
            if (!IsApi(request)) return ReleasePageResponse(request);
            var response = new HttpResponseMessage(HttpStatusCode.Forbidden);
            response.Headers.RetryAfter = absolute
                ? new RetryConditionHeaderValue(Now.AddSeconds(90))
                : new RetryConditionHeaderValue(TimeSpan.FromSeconds(90));
            response.Headers.Add("x-ratelimit-remaining", "5");
            response.Headers.Add("x-ratelimit-reset", Now.AddHours(1).ToUnixTimeSeconds().ToString());
            return response;
        });
        var resolver = new UpdateReleaseClient(http, () => Now);

        await resolver.FetchLatestAsync();

        Assert.Equal(Now.AddSeconds(90), resolver.ApiRetryAt);
        Assert.True(resolver.UsedFallback);
    }

    [Fact]
    public async Task ExhaustedQuotaWaitsForBothRetryAfterAndReset()
    {
        using var http = Http(request =>
        {
            if (!IsApi(request)) return ReleasePageResponse(request);
            var response = RateLimited(reset: Now.AddMinutes(2));
            response.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromMinutes(3));
            return response;
        });
        var resolver = new UpdateReleaseClient(http, () => Now);
        await resolver.FetchLatestAsync();
        Assert.Equal(Now.AddMinutes(3), resolver.ApiRetryAt);
    }

    [Theory]
    [InlineData("not-a-number")]
    [InlineData("9223372036854775807")]
    [InlineData("0")]
    public async Task InvalidResetHeaderUsesCooldownWithoutClaimingARecoveryTime(string reset)
    {
        var apiCalls = 0;
        using var http = Http(request =>
        {
            if (!IsApi(request)) return ReleasePageResponse(request);
            apiCalls++;
            var response = RateLimited();
            response.Headers.Add("x-ratelimit-reset", reset);
            return response;
        });
        var resolver = new UpdateReleaseClient(http, () => Now);
        await resolver.FetchLatestAsync();
        await resolver.FetchLatestAsync();
        Assert.Equal(1, apiCalls);
        Assert.Null(resolver.ApiRetryAt);
    }

    [Theory]
    [InlineData(403)]
    [InlineData(500)]
    public async Task OtherHttpErrorsDoNotPretendToBeRateLimits(int status)
    {
        var calls = 0;
        using var http = Http(_ => { calls++; return new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent("Access denied") }; });
        var resolver = new UpdateReleaseClient(http);
        await Assert.ThrowsAsync<HttpRequestException>(() => resolver.FetchLatestAsync());
        Assert.Equal(1, calls);
        Assert.False(resolver.UsedFallback);
        Assert.Null(resolver.ApiRetryAt);
    }

    [Theory]
    [InlineData("https://example.test/xiufengsun/TokenTracker/releases/tag/v1.3.9")]
    [InlineData("http://github.com/xiufengsun/TokenTracker/releases/tag/v1.3.9")]
    [InlineData("https://github.com/another/repo/releases/tag/v1.3.9")]
    [InlineData("https://github.com/xiufengsun/TokenTracker/releases/latest")]
    [InlineData("https://github.com/xiufengsun/TokenTracker/releases/tag/v1.3.9-rc.1")]
    [InlineData("https://github.com/xiufengsun/TokenTracker/releases/tag/v1.3.9/extra")]
    public async Task FallbackRejectsUnexpectedRedirectsAndInvalidTags(string redirect)
    {
        var calls = 0;
        using var http = Http(request => { calls++; return IsApi(request) ? RateLimited() : ReleasePageResponse(request, redirect); });
        var resolver = new UpdateReleaseClient(http);
        await Assert.ThrowsAsync<InvalidDataException>(() => resolver.FetchLatestAsync());
        Assert.Equal(2, calls);
    }

    [Theory]
    [InlineData("installer-missing")]
    [InlineData("size-missing")]
    [InlineData("checksums-missing")]
    [InlineData("checksum-entry-missing")]
    public async Task FallbackFailsWhenInstallerCannotBeDownloadedAndVerified(string failure)
    {
        using var http = Http(request =>
        {
            if (IsApi(request)) return RateLimited();
            if (request.RequestUri!.AbsoluteUri.EndsWith("TokenTracker-Setup.exe"))
            {
                if (failure == "installer-missing") return new HttpResponseMessage(HttpStatusCode.NotFound);
                if (failure == "size-missing") return new HttpResponseMessage(HttpStatusCode.OK);
            }
            if (request.RequestUri.AbsoluteUri.EndsWith("SHA256SUMS"))
            {
                if (failure == "checksums-missing") return new HttpResponseMessage(HttpStatusCode.NotFound);
                if (failure == "checksum-entry-missing") return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(new string('a', 64) + "  other.exe") };
            }
            return ReleasePageResponse(request);
        });
        var resolver = new UpdateReleaseClient(http);
        var error = await Record.ExceptionAsync(() => resolver.FetchLatestAsync());
        Assert.True(error is HttpRequestException or InvalidDataException);
        Assert.True(resolver.UsedFallback);
    }

    [Fact]
    public async Task FallbackFailureKeepsApiCooldownForNextCheck()
    {
        var apiCalls = 0;
        using var http = Http(request =>
        {
            if (!IsApi(request)) return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
            apiCalls++;
            return RateLimited(reset: Now.AddHours(1));
        });
        var resolver = new UpdateReleaseClient(http, () => Now);
        await Assert.ThrowsAsync<HttpRequestException>(() => resolver.FetchLatestAsync());
        await Assert.ThrowsAsync<HttpRequestException>(() => resolver.FetchLatestAsync());
        Assert.Equal(1, apiCalls);
        Assert.Equal(Now.AddHours(1), resolver.ApiRetryAt);
    }

    [Fact]
    public async Task MissingApiInstallerIsFailedRatherThanUpToDate()
    {
        using var http = Http(_ => ApiRelease(includeInstaller: false));
        var checker = new UpdateChecker(http);
        Assert.Equal(UpdateChecker.CheckOutcome.Failed, await checker.CheckAsync(silent: false));
        Assert.Equal(UpdateChecker.UpdateState.Idle, checker.State);
    }

    [Fact]
    public async Task BothPathsFailWithoutClaimingAnUpdateOrLaunchingInstallation()
    {
        var resetAt = DateTimeOffset.UtcNow.AddHours(1);
        using var http = Http(request => IsApi(request) ? RateLimited(resetAt)
            : new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
        var checker = new UpdateChecker(http);
        var quitRequested = false;
        checker.QuitRequested += () => quitRequested = true;

        Assert.Equal(UpdateChecker.CheckOutcome.Failed, await checker.CheckAsync(silent: false));
        Assert.Equal(UpdateChecker.UpdateState.Idle, checker.State);
        Assert.Null(checker.LatestVersion);
        Assert.Equal(resetAt.ToUnixTimeSeconds(), checker.ApiRetryAt!.Value.ToUnixTimeSeconds());
        Assert.False(quitRequested);
    }

    [Fact]
    public async Task ExistingVersionStillReportsUpToDate()
    {
        using var http = Http(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new {
            tag_name = "v0.0.0",
            assets = new[] { new { name = "TokenTracker-Setup.exe", browser_download_url = "https://github.com/xiufengsun/TokenTracker/releases/download/v0.0.0/TokenTracker-Setup.exe", size = 900 } },
        })) });
        var checker = new UpdateChecker(http);
        Assert.Equal(UpdateChecker.CheckOutcome.UpToDate, await checker.CheckAsync(silent: false));
        Assert.Equal(UpdateChecker.UpdateState.Idle, checker.State);
    }

    [Fact]
    public async Task ManualCheckUsesFallbackAndLeavesInstallationToTheUser()
    {
        var calls = new List<HttpMethod>();
        using var http = Http(request =>
        {
            calls.Add(request.Method);
            return IsApi(request) ? RateLimited() : ReleasePageResponse(request);
        });
        var checker = new UpdateChecker(http);
        var quitRequested = false;
        checker.QuitRequested += () => quitRequested = true;
        Assert.Equal(UpdateChecker.CheckOutcome.UpdateAvailable, await checker.CheckAsync(silent: false));
        Assert.Equal(UpdateChecker.UpdateState.UpdateAvailable, checker.State);
        Assert.Equal("1.3.9", checker.LatestVersion);
        Assert.Equal(new[] { HttpMethod.Get, HttpMethod.Head, HttpMethod.Head, HttpMethod.Get }, calls);
        Assert.False(quitRequested);
    }

    [Fact]
    public async Task RepeatedManualClickDoesNotStartAnotherRequest()
    {
        var calls = 0;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var response = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var http = new HttpClient(new Handler(async (_, cancellationToken) =>
        {
            calls++;
            entered.SetResult();
            return await response.Task.WaitAsync(cancellationToken);
        }));
        var checker = new UpdateChecker(http);
        var first = checker.CheckAsync(silent: false);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(UpdateChecker.UpdateState.Checking, checker.State);
        Assert.Equal(UpdateChecker.CheckOutcome.Skipped, await checker.CheckAsync(silent: false));
        response.SetResult(ApiRelease());
        Assert.Equal(UpdateChecker.CheckOutcome.UpdateAvailable, await first);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task SimultaneousChecksAdmitOnlyOneReleaseRequest()
    {
        const int callers = 16;
        var calls = 0;
        var skipped = 0;
        var rejected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var start = new Barrier(callers);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var response = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var http = new HttpClient(new Handler(async (_, cancellationToken) =>
        {
            Interlocked.Increment(ref calls);
            entered.TrySetResult();
            return await response.Task.WaitAsync(cancellationToken);
        }));
        var checker = new UpdateChecker(http);
        var checks = Enumerable.Range(0, callers).Select(_ => Task.Factory.StartNew(async () =>
        {
            if (!start.SignalAndWait(TimeSpan.FromSeconds(10)))
                throw new TimeoutException("Concurrent update checks did not start together");
            var outcome = await checker.CheckAsync(silent: false);
            if (outcome == UpdateChecker.CheckOutcome.Skipped && Interlocked.Increment(ref skipped) == callers - 1)
                rejected.TrySetResult();
            return outcome;
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap()).ToArray();
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            // All rejected callers can finish while the admitted request is blocked.
            await rejected.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(UpdateChecker.UpdateState.Checking, checker.State);
        }
        finally
        {
            response.TrySetResult(ApiRelease());
        }
        var results = await Task.WhenAll(checks).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(1, calls);
        Assert.Equal(1, results.Count(result => result == UpdateChecker.CheckOutcome.UpdateAvailable));
        Assert.Equal(callers - 1, results.Count(result => result == UpdateChecker.CheckOutcome.Skipped));
    }

    private static bool IsApi(HttpRequestMessage request) => request.RequestUri!.Host == "api.github.com";

    private static HttpResponseMessage ApiRelease(bool includeInstaller = true)
        => new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new {
            tag_name = "v1.3.9",
            assets = includeInstaller ? new[] {
                new { name = "TokenTracker-Setup.exe", browser_download_url = AssetBase + "TokenTracker-Setup.exe", size = 900 },
                new { name = "SHA256SUMS", browser_download_url = AssetBase + "SHA256SUMS", size = 90 },
            } : [],
        })) };

    private static HttpResponseMessage RateLimited(DateTimeOffset? reset = null)
    {
        var response = new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("API rate limit exceeded") };
        response.Headers.Add("x-ratelimit-remaining", "0");
        if (reset is not null) response.Headers.Add("x-ratelimit-reset", reset.Value.ToUnixTimeSeconds().ToString());
        return response;
    }

    private static HttpResponseMessage ReleasePageResponse(HttpRequestMessage request, string redirect = TagUrl)
    {
        if (request.RequestUri!.AbsoluteUri == UpdateReleaseClient.ReleasePageUrl)
            return new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = new HttpRequestMessage(HttpMethod.Head, redirect) };
        if (request.RequestUri.AbsoluteUri == AssetBase + "TokenTracker-Setup.exe")
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK);
            response.Content.Headers.ContentLength = 900;
            return response;
        }
        if (request.RequestUri.AbsoluteUri == AssetBase + "SHA256SUMS")
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(new string('a', 64) + "  TokenTracker-Setup.exe\n") };
        throw new InvalidOperationException("Unexpected test request: " + request.RequestUri.AbsolutePath);
    }

    private static HttpClient Http(Func<HttpRequestMessage, HttpResponseMessage> respond)
        => new(new Handler((request, _) => Task.FromResult(respond(request))));

    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => respond(request, cancellationToken);
    }
}
