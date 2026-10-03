using TokenTrackerWin;
using Xunit;

namespace TokenTrackerWin.Tests;

public sealed class TiltWheelScrollForwarderTests
{
    [Fact]
    public void DeltaConvertsToStepPixels()
    {
        // One notch = WHEEL_DELTA (120) = 45px ≈ 3 heatmap week columns;
        // high-resolution wheels report multiples of a notch and scale linearly.
        Assert.Equal(45.0, TiltWheelScrollForwarder.ComputeScrollDeltaPx(120));
        Assert.Equal(-45.0, TiltWheelScrollForwarder.ComputeScrollDeltaPx(-120));
        Assert.Equal(90.0, TiltWheelScrollForwarder.ComputeScrollDeltaPx(240));
    }

    [Fact]
    public void RightTiltProducesPositiveScrollIncrement()
    {
        // Right tilt is a positive delta and must scroll right (towards the newer
        // heatmap dates); left tilt mirrors it exactly.
        var right = TiltWheelScrollForwarder.ComputeScrollDeltaPx(120);
        var left = TiltWheelScrollForwarder.ComputeScrollDeltaPx(-120);
        Assert.NotNull(right);
        Assert.NotNull(left);
        Assert.True(right > 0);
        Assert.True(left < 0);
        Assert.Equal(-left, right);
    }

    [Fact]
    public void ZeroDeltaIsDropped()
    {
        Assert.Null(TiltWheelScrollForwarder.ComputeScrollDeltaPx(0));
        Assert.Null(TiltWheelScrollForwarder.BuildScrollScript(coreReady: true, exiting: false, delta: 0, x: 10, y: 10));
    }

    [Fact]
    public void NotReadyCoreProducesNoScript()
    {
        Assert.Null(TiltWheelScrollForwarder.BuildScrollScript(coreReady: false, exiting: false, delta: 120, x: 10, y: 10));
    }

    [Fact]
    public void ExitingAppProducesNoScript()
    {
        Assert.Null(TiltWheelScrollForwarder.BuildScrollScript(coreReady: true, exiting: true, delta: 120, x: 10, y: 10));
    }

    [Fact]
    public void ScriptEmbedsCoordinatesAndDelta()
    {
        var script = TiltWheelScrollForwarder.BuildScrollScript(coreReady: true, exiting: false, delta: 120, x: 512.5, y: 300.25);
        Assert.NotNull(script);
        // The invocation tail carries (x, y, deltaPx) into the IIFE's parameters.
        Assert.Contains("})(512.5, 300.25, 45)", script);
    }

    [Fact]
    public void ScriptEmbedsNegativeDeltaForLeftTilt()
    {
        var script = TiltWheelScrollForwarder.BuildScrollScript(coreReady: true, exiting: false, delta: -120, x: 512.5, y: 300.25);
        Assert.NotNull(script);
        Assert.Contains("})(512.5, 300.25, -45)", script);
    }

    [Fact]
    public void ScriptFormatsNumbersWithInvariantCulture()
    {
        // Locales using comma decimals must not leak ',' into the JS numeric
        // literals ("512,5" would be a syntax error, not two arguments).
        var script = TiltWheelScrollForwarder.BuildScrollScript(coreReady: true, exiting: false, delta: 120, x: 512.5, y: 300.25);
        Assert.NotNull(script);
        Assert.Contains("512.5", script);
        Assert.Contains("300.25", script);
        Assert.DoesNotContain("512,5", script);
        Assert.DoesNotContain("300,25", script);
    }

    [Fact]
    public void ExtractsSignedWheelDeltaFromWParam()
    {
        // wParam: low word = flags, high word = delta (+120 / -120).
        Assert.Equal(120, TiltWheelScrollForwarder.ExtractWheelDelta((nint)0x00780001));
        Assert.Equal(-120, TiltWheelScrollForwarder.ExtractWheelDelta(unchecked((nint)(int)0xFF880001)));
    }

    [Fact]
    public void ExtractsSignedScreenPointFromLParam()
    {
        // lParam: low word = x, high word = y, both signed (multi-monitor setups
        // left of the primary screen report negative coordinates).
        var (x, y) = TiltWheelScrollForwarder.ExtractScreenPoint((nint)((300 << 16) | unchecked((ushort)(short)-50)));
        Assert.Equal(-50, x);
        Assert.Equal(300, y);

        var (nx, ny) = TiltWheelScrollForwarder.ExtractScreenPoint((nint)(int)((-200 << 16) | 100));
        Assert.Equal(100, nx);
        Assert.Equal(-200, ny);
    }
}
