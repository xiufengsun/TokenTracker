using Xunit;

namespace TokenTrackerWin;

public class DocumentScriptCacheTests
{
    [Fact]
    public void OldNavigationAcknowledgmentCannotSuppressNewDocumentContext()
    {
        var cache = new DocumentScriptCache();
        Assert.True(cache.TryStart("state", out var old));
        cache.Invalidate();
        cache.Complete(old, true);
        Assert.True(cache.TryStart("state", out var current));
        cache.Complete(current, true);
        Assert.False(cache.TryStart("state", out _));
    }

    [Fact]
    public void RevertingStateWhileAnotherSendIsPendingStillSendsTheRevertedState()
    {
        var cache = new DocumentScriptCache();
        Assert.True(cache.TryStart("A", out var first));
        cache.Complete(first, true);
        Assert.True(cache.TryStart("B", out var second));
        Assert.True(cache.TryStart("A", out var reverted));
        cache.Complete(reverted, true);
        cache.Complete(second, true);
        Assert.False(cache.TryStart("A", out _));
    }

    [Fact]
    public void FailedInjectionCanRetryAndDuplicatePendingSnapshotsAreCoalesced()
    {
        var cache = new DocumentScriptCache();
        Assert.True(cache.TryStart("state", out var pending));
        Assert.False(cache.TryStart("state", out _));
        cache.Complete(pending, false);
        Assert.True(cache.TryStart("state", out _));
    }
}
