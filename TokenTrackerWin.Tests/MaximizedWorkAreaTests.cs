using TokenTrackerWin;
using Xunit;

namespace TokenTrackerWin.Tests;

public sealed class MaximizedWorkAreaTests
{
    private static MaximizedWorkArea.ScreenRect Rect(int left, int top, int right, int bottom) =>
        new(left, top, right, bottom);

    [Fact]
    public void BottomTaskbarUsesWorkAreaNotFullMonitor()
    {
        // 1920x1080 display with a 40px taskbar along the bottom.
        var monitor = Rect(0, 0, 1920, 1080);
        var work = Rect(0, 0, 1920, 1040);

        Assert.True(MaximizedWorkArea.TryCompute(work, monitor, out var placement));
        Assert.Equal(0, placement.PositionX);
        Assert.Equal(0, placement.PositionY);
        Assert.Equal(1920, placement.SizeX);
        Assert.Equal(1040, placement.SizeY);
        Assert.NotEqual(monitor.Height, placement.SizeY);
    }

    [Fact]
    public void LeftTaskbarInsetsPositionAndWidth()
    {
        var monitor = Rect(0, 0, 1920, 1080);
        var work = Rect(48, 0, 1920, 1080);

        Assert.True(MaximizedWorkArea.TryCompute(work, monitor, out var placement));
        Assert.Equal(48, placement.PositionX);
        Assert.Equal(0, placement.PositionY);
        Assert.Equal(1872, placement.SizeX);
        Assert.Equal(1080, placement.SizeY);
    }

    [Fact]
    public void TopTaskbarInsetsPositionAndHeight()
    {
        var monitor = Rect(0, 0, 1920, 1080);
        var work = Rect(0, 40, 1920, 1080);

        Assert.True(MaximizedWorkArea.TryCompute(work, monitor, out var placement));
        Assert.Equal(0, placement.PositionX);
        Assert.Equal(40, placement.PositionY);
        Assert.Equal(1920, placement.SizeX);
        Assert.Equal(1040, placement.SizeY);
    }

    [Fact]
    public void RightTaskbarShrinksWidthOnly()
    {
        var monitor = Rect(0, 0, 1920, 1080);
        var work = Rect(0, 0, 1872, 1080);

        Assert.True(MaximizedWorkArea.TryCompute(work, monitor, out var placement));
        Assert.Equal(0, placement.PositionX);
        Assert.Equal(0, placement.PositionY);
        Assert.Equal(1872, placement.SizeX);
        Assert.Equal(1080, placement.SizeY);
    }

    [Fact]
    public void AutoHideTaskbarFillsTheMonitor()
    {
        // Auto-hide leaves rcWork equal to rcMonitor, so the window should
        // fill the screen and let the taskbar slide over it.
        var monitor = Rect(0, 0, 1920, 1080);

        Assert.True(MaximizedWorkArea.TryCompute(monitor, monitor, out var placement));
        Assert.Equal(0, placement.PositionX);
        Assert.Equal(0, placement.PositionY);
        Assert.Equal(1920, placement.SizeX);
        Assert.Equal(1080, placement.SizeY);
    }

    [Fact]
    public void SecondaryMonitorLeftOfOriginStaysRelativeToThatMonitor()
    {
        // A 1920x1080 display to the left of the primary, taskbar at the bottom.
        // Screen coordinates are negative; the maximized offset must still be
        // relative to that monitor, not the virtual-screen origin.
        var monitor = Rect(-1920, 0, 0, 1080);
        var work = Rect(-1920, 0, 0, 1040);

        Assert.True(MaximizedWorkArea.TryCompute(work, monitor, out var placement));
        Assert.Equal(0, placement.PositionX);
        Assert.Equal(0, placement.PositionY);
        Assert.Equal(1920, placement.SizeX);
        Assert.Equal(1040, placement.SizeY);
    }

    [Fact]
    public void SecondaryMonitorLeftTaskbarUsesWorkInset()
    {
        var monitor = Rect(-1920, 0, 0, 1080);
        var work = Rect(-1872, 0, 0, 1080);

        Assert.True(MaximizedWorkArea.TryCompute(work, monitor, out var placement));
        Assert.Equal(48, placement.PositionX);
        Assert.Equal(0, placement.PositionY);
        Assert.Equal(1872, placement.SizeX);
        Assert.Equal(1080, placement.SizeY);
    }

    [Fact]
    public void EmptyWorkAreaIsRejected()
    {
        var monitor = Rect(0, 0, 1920, 1080);
        Assert.False(MaximizedWorkArea.TryCompute(Rect(0, 0, 0, 1080), monitor, out _));
        Assert.False(MaximizedWorkArea.TryCompute(Rect(0, 0, 1920, 0), monitor, out _));
        Assert.False(MaximizedWorkArea.TryCompute(Rect(100, 100, 50, 200), monitor, out _));
    }
}
