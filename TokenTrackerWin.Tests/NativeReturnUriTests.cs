using Xunit;

namespace TokenTrackerWin;

public sealed class NativeReturnUriTests
{
    private const string Order = "d03c54ea-a98e-4411-84f5-875e0db9b8ca";
    private const string Billing = "tokentracker://billing/return?order=" + Order;

    [Fact]
    public void BillingReturnOnlyBuildsAnOrderLookupRoute()
    {
        Assert.True(NativeReturnUri.TryGetBillingOrder(Billing, out var order));
        Assert.Equal(Guid.Parse(Order), order);
        Assert.Equal("/billing/checkout?order=" + Order + "&app=1", NativeReturnUri.CheckoutPath(order));
        Assert.False(NativeReturnUri.TryGetAuthCode(Billing, out _));
    }

    [Theory]
    [InlineData("d03c54ea-a98e-1411-84f5-875e0db9b8ca")]
    [InlineData("d03c54ea-a98e-2411-94f5-875e0db9b8ca")]
    [InlineData("d03c54ea-a98e-3411-a4f5-875e0db9b8ca")]
    [InlineData("d03c54ea-a98e-5411-b4f5-875e0db9b8ca")]
    public void BillingOrderAcceptsSupportedUuidVersionsAndVariants(string value)
    {
        Assert.True(NativeReturnUri.TryGetBillingOrder("tokentracker://billing/return?order=" + value, out var order));
        Assert.Equal(value, order.ToString("D"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("tokentracker://billing/return")]
    [InlineData("tokentracker://billing/return?order=")]
    [InlineData("tokentracker://billing/return?order=not-a-uuid")]
    [InlineData("tokentracker://billing/return?order=d03c54eaa98e441184f5875e0db9b8ca")]
    [InlineData("tokentracker://billing/return?order={d03c54ea-a98e-4411-84f5-875e0db9b8ca}")]
    [InlineData("tokentracker://billing/return?order=D03C54EA-A98E-4411-84F5-875E0DB9B8CA")]
    [InlineData("tokentracker://billing/return?order=00000000-0000-0000-0000-000000000000")]
    [InlineData("tokentracker://billing/return?order=d03c54ea-a98e-0411-84f5-875e0db9b8ca")]
    [InlineData("tokentracker://billing/return?order=d03c54ea-a98e-6411-84f5-875e0db9b8ca")]
    [InlineData("tokentracker://billing/return?order=d03c54ea-a98e-4411-74f5-875e0db9b8ca")]
    [InlineData("tokentracker://billing/return?order=d03c54ea-a98e-4411-f4f5-875e0db9b8ca")]
    [InlineData("tokentracker-qa-auth://billing/return?order=" + Order)]
    [InlineData("https://billing/return?order=" + Order)]
    [InlineData("tokentracker://sandbox/billing/return?order=" + Order)]
    [InlineData("tokentracker://billing/return?order=" + Order + "&realm=sandbox")]
    [InlineData("tokentracker://billing/return?order=" + Order + "&order=" + Order)]
    [InlineData("tokentracker://billing/return?order=" + Order + "&paid=true")]
    [InlineData("tokentracker://billing/return?order=" + Order + "&app=1")]
    [InlineData("tokentracker://billing/return?order=" + Order + "#")]
    [InlineData("tokentracker://billing/return?order=" + Order + "#paid")]
    [InlineData("tokentracker://user@billing/return?order=" + Order)]
    [InlineData("tokentracker://@billing/return?order=" + Order)]
    [InlineData("tokentracker://billing:443/return?order=" + Order)]
    [InlineData("tokentracker://billing:/return?order=" + Order)]
    [InlineData("tokentracker://billing/return/?order=" + Order)]
    [InlineData("tokentracker://billing/%72eturn?order=" + Order)]
    [InlineData("tokentracker://billing/return?%6Frder=" + Order)]
    [InlineData("tokentracker://billing/return?order=d03c54ea%2Da98e-4411-84f5-875e0db9b8ca")]
    [InlineData(" " + Billing)]
    [InlineData(Billing + "\n")]
    public void BillingReturnRejectsAmbiguousOrPollutedInput(string? value)
    {
        Assert.False(NativeReturnUri.TryGetBillingOrder(value, out var order));
        Assert.Equal(Guid.Empty, order);
    }

    [Fact]
    public void NormalizedUriPathCannotAuthorizeANoncanonicalBillingReturn()
    {
        var value = "tokentracker://billing/other/../return?order=" + Order;
        var uri = new Uri(value);
        Assert.Equal("/return", uri.AbsolutePath);
        Assert.False(NativeReturnUri.TryGetBillingOrder(value, out _));
    }

    [Theory]
    [InlineData("tokentracker://auth/callback?insforge_code=sample-code", "sample-code")]
    [InlineData("tokentracker://auth/callback?insforge_code=sample%2Bcode%2Fwith%3Dvalue", "sample+code/with=value")]
    [InlineData("TOKENtracker://AUTH/callback?insforge_code=%61uth%2Bcode", "auth+code")]
    public void ExistingOAuthCallbackKeepsItsCodeAndEscaping(string value, string expected)
    {
        Assert.True(NativeReturnUri.TryGetAuthCode(value, out var code));
        Assert.Equal(expected, code);
        Assert.False(NativeReturnUri.TryGetBillingOrder(value, out _));
    }

    [Theory]
    [InlineData("tokentracker-qa-auth://auth/callback?insforge_code=sample")]
    [InlineData("https://auth/callback?insforge_code=sample")]
    [InlineData("tokentracker://auth/other?insforge_code=sample")]
    [InlineData("tokentracker://billing/return?insforge_code=sample")]
    [InlineData("tokentracker://auth/callback?insforge_code=sample&realm=sandbox")]
    [InlineData("tokentracker://auth/callback?insforge_code=sample&insforge_code=other")]
    [InlineData("tokentracker://auth/callback?insforge_code=sample#fragment")]
    [InlineData("tokentracker://user@auth/callback?insforge_code=sample")]
    [InlineData("tokentracker://@auth/callback?insforge_code=sample")]
    [InlineData("tokentracker://auth:123/callback?insforge_code=sample")]
    [InlineData("tokentracker://auth/callback?insforge_code=")]
    [InlineData("tokentracker://auth/callback?INSFORGE_CODE=sample")]
    public void OAuthRejectsOtherRoutesAndQARealmPollution(string value)
    {
        Assert.False(NativeReturnUri.TryGetAuthCode(value, out _));
    }

    [Fact]
    public void EntryPointOnlyFindsTheOrdinaryProductScheme()
    {
        Assert.Null(NativeReturnUri.FindArgument(["--startup", "tokentracker-qa-auth://auth/callback?insforge_code=sample"]));
        Assert.Equal(Billing, NativeReturnUri.FindArgument(["--startup", Billing]));
        Assert.Equal("TOKENtracker://AUTH/callback?insforge_code=sample",
            NativeReturnUri.FindArgument(["TOKENtracker://AUTH/callback?insforge_code=sample"]));
    }
}
