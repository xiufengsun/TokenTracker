using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Xunit;

namespace TokenTrackerWin;

public sealed class LocalSyncPublisherTests
{
    [Fact]
    public async Task AuthenticatesThenPublishesExactBackgroundPayload()
    {
        const string baseUrl = "http://127.0.0.1:17680";
        var requests = new List<CapturedRequest>();
        using var client = new HttpClient(new ScriptedHandler(async (request, cancellationToken) =>
        {
            var body = request.Content is null
                ? ""
                : await request.Content.ReadAsStringAsync(cancellationToken);
            var localAuth = request.Headers.TryGetValues(
                "x-tokentracker-local-auth", out var values)
                ? values.SingleOrDefault()
                : null;
            requests.Add(new CapturedRequest(request.Method, request.RequestUri!, localAuth, body));
            return JsonResponse(requests.Count == 1
                ? "{\"token\":\"local-secret\"}"
                : "{\"ok\":true}");
        }));

        var publisher = new LocalSyncPublisher(client, baseUrl);
        await publisher.PublishAsync();

        Assert.Equal(2, requests.Count);
        Assert.Equal(HttpMethod.Get, requests[0].Method);
        Assert.Equal(baseUrl + "/api/local-auth", requests[0].Uri.ToString());
        Assert.Null(requests[0].LocalAuth);
        Assert.Equal(HttpMethod.Post, requests[1].Method);
        Assert.Equal(baseUrl + "/functions/tokentracker-local-sync", requests[1].Uri.ToString());
        Assert.Equal("local-secret", requests[1].LocalAuth);
        Assert.Equal(
            "{\"auto\":true,\"background\":true,\"allLocalSources\":true,\"publishAccount\":true,\"nativeOnlyWsl\":true}",
            requests[1].Body);

        using var document = JsonDocument.Parse(requests[1].Body);
        var payload = document.RootElement;
        Assert.Equal(5, payload.EnumerateObject().Count());
        Assert.True(payload.GetProperty("auto").GetBoolean());
        Assert.True(payload.GetProperty("background").GetBoolean());
        Assert.True(payload.GetProperty("allLocalSources").GetBoolean());
        Assert.True(payload.GetProperty("publishAccount").GetBoolean());
        Assert.True(payload.GetProperty("nativeOnlyWsl").GetBoolean());
    }

    [Fact]
    public async Task RejectsNonSuccessAuthResponseWithoutEchoingResponseBody()
    {
        var calls = 0;
        using var client = new HttpClient(new ScriptedHandler((_, _) =>
        {
            calls++;
            return Task.FromResult(JsonResponse(
                "{\"error\":\"local-secret\"}",
                HttpStatusCode.ServiceUnavailable));
        }));

        var publisher = new LocalSyncPublisher(client, "http://127.0.0.1:17680");
        var error = await Assert.ThrowsAsync<HttpRequestException>(
            () => publisher.PublishAsync());

        Assert.Equal(1, calls);
        Assert.DoesNotContain("local-secret", error.Message);
    }

    [Fact]
    public async Task RejectsMissingAuthTokenWithoutEchoingResponseBody()
    {
        using var client = new HttpClient(new ScriptedHandler((_, _) =>
            Task.FromResult(JsonResponse("{\"error\":\"local-secret\"}"))));

        var publisher = new LocalSyncPublisher(client, "http://127.0.0.1:17680");
        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => publisher.PublishAsync());

        Assert.Equal("Local auth response did not include a token.", error.Message);
        Assert.DoesNotContain("local-secret", error.Message);
    }

    [Fact]
    public async Task PropagatesCancellationDuringPost()
    {
        var postStarted = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        using var client = new HttpClient(new ScriptedHandler(async (request, cancellationToken) =>
        {
            calls++;
            if (calls == 1) return JsonResponse("{\"token\":\"local-secret\"}");

            postStarted.SetResult(true);
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("unreachable");
        }));

        var publisher = new LocalSyncPublisher(client, "http://127.0.0.1:17680");
        using var cancellation = new CancellationTokenSource();
        var publishTask = publisher.PublishAsync(cancellation.Token);
        await postStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => publishTask);
        Assert.Equal(2, calls);
    }

    private static HttpResponseMessage JsonResponse(
        string body,
        HttpStatusCode status = HttpStatusCode.OK)
        => new(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };

    private sealed record CapturedRequest(
        HttpMethod Method,
        Uri Uri,
        string? LocalAuth,
        string Body);

    private sealed class ScriptedHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> script)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => script(request, cancellationToken);
    }
}
