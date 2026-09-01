using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace TokenTrackerWin;

/// <summary>
/// Performs the authenticated loopback exchange used by native background sync.
/// Keeping this protocol separate from the process lifecycle makes the request
/// ordering, flags, and cancellation behavior independently testable.
/// </summary>
internal sealed class LocalSyncPublisher
{
    private const string LocalAuthHeader = "x-tokentracker-local-auth";
    private const string BackgroundSyncBody =
        "{\"auto\":true,\"background\":true,\"allLocalSources\":true,\"publishAccount\":true,\"nativeOnlyWsl\":true}";

    private readonly HttpClient _httpClient;
    private readonly string _baseUrl;

    public LocalSyncPublisher(HttpClient httpClient, string baseUrl)
    {
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        if (string.IsNullOrWhiteSpace(baseUrl))
            throw new ArgumentException("A loopback base URL is required.", nameof(baseUrl));
        _baseUrl = baseUrl.TrimEnd('/');
    }

    public async Task PublishAsync(CancellationToken cancellationToken = default)
    {
        using var authResponse = await _httpClient.GetAsync(
            _baseUrl + "/api/local-auth",
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        authResponse.EnsureSuccessStatusCode();

        var authPayload = await authResponse.Content.ReadAsStringAsync(cancellationToken);
        var localAuthToken = ReadLocalAuthToken(authPayload);

        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            _baseUrl + "/functions/tokentracker-local-sync");
        request.Headers.TryAddWithoutValidation(LocalAuthHeader, localAuthToken);
        request.Content = new StringContent(BackgroundSyncBody, Encoding.UTF8, "application/json");

        using var response = await _httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        response.EnsureSuccessStatusCode();
        // The local API writes its response after the sync child exits. Consume
        // it so PublishAsync does not complete before that child is finished.
        await response.Content.ReadAsStringAsync(cancellationToken);
    }

    private static string ReadLocalAuthToken(string payload)
    {
        try
        {
            using var document = JsonDocument.Parse(payload);
            if (document.RootElement.ValueKind == JsonValueKind.Object &&
                document.RootElement.TryGetProperty("token", out var tokenElement) &&
                tokenElement.ValueKind == JsonValueKind.String)
            {
                var token = tokenElement.GetString();
                if (!string.IsNullOrWhiteSpace(token)) return token;
            }
        }
        catch (JsonException)
        {
            // Convert malformed auth responses to the same safe protocol error
            // without echoing a response body that could contain credentials.
        }

        throw new InvalidOperationException("Local auth response did not include a token.");
    }
}
