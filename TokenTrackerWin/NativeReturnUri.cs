namespace TokenTrackerWin;

internal static class NativeReturnUri
{
    private const string BillingPrefix = "tokentracker://billing/return?order=";
    private const string AuthPrefix = "tokentracker://auth/callback?";
    private const string AuthQueryKey = "insforge_code=";

    internal static string? FindArgument(string[] args) =>
        args.FirstOrDefault(value => value.StartsWith("tokentracker://", StringComparison.OrdinalIgnoreCase));

    internal static bool TryGetBillingOrder(string? value, out Guid order)
    {
        order = default;
        if (value is null || !Uri.TryCreate(value, UriKind.Absolute, out _)
            || !value.StartsWith(BillingPrefix, StringComparison.Ordinal)) return false;

        var rawOrder = value[BillingPrefix.Length..];
        if (!Guid.TryParseExact(rawOrder, "D", out var parsed)
            || !string.Equals(rawOrder, parsed.ToString("D"), StringComparison.Ordinal)
            || rawOrder[14] is < '1' or > '5'
            || rawOrder[19] is not ('8' or '9' or 'a' or 'b')) return false;

        order = parsed;
        return true;
    }

    internal static string CheckoutPath(Guid order) => $"/billing/checkout?order={order:D}&app=1";

    internal static bool TryGetAuthCode(string? value, out string code)
    {
        code = "";
        if (value is null || !Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || !value.StartsWith(AuthPrefix, StringComparison.OrdinalIgnoreCase)
            || uri.AbsolutePath != "/callback"
            || uri.Query.Contains('&') || !string.IsNullOrEmpty(uri.Fragment)
            || value != value.Trim()) return false;

        var query = value[AuthPrefix.Length..];
        if (!query.StartsWith(AuthQueryKey, StringComparison.Ordinal)) return false;
        var rawCode = query[AuthQueryKey.Length..];
        if (rawCode.Length == 0) return false;
        code = Uri.UnescapeDataString(rawCode);
        return code.Length > 0;
    }
}
