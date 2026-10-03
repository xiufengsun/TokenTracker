using System.Globalization;

namespace TokenTrackerWin;

/// <summary>
/// Pure logic behind the dashboard window's tilt-wheel (horizontal mouse wheel)
/// support: converts a <c>WM_MOUSEHWHEEL</c> (0x020E) delta into a horizontal
/// scroll increment and builds the JS snippet that hit-tests the hovered point
/// and scrolls the nearest horizontally-scrollable ancestor.
///
/// This exists because WPF has no horizontal-wheel routed event and the
/// composition-hosted <c>WebView2CompositionControl</c> only forwards WPF input —
/// so tilt messages never reach the Chromium page on their own. The host window
/// intercepts them via an <c>HwndSource</c> hook (see <c>DashboardWindow</c>) and
/// runs the generated script through <c>ExecuteScriptAsync</c>. Vertical wheeling
/// (WM_MOUSEWHEEL) is untouched and keeps flowing through the normal channel.
/// Kept free of UI dependencies so the conversion + script building is unit
/// testable (same style as <see cref="DispatcherExceptionPolicy"/>).
/// </summary>
internal static class TiltWheelScrollForwarder
{
    /// <summary>Windows WHEEL_DELTA: one full notch of a standard tilt wheel.</summary>
    internal const double WheelDelta = 120;

    /// <summary>
    /// CSS pixels scrolled per full notch. The heatmap's week columns are a 12px
    /// cell + 3px gap = 15px, so 45px ≈ 3 columns per tilt — enough to move
    /// meaningfully, little enough to keep the months readable while tilting.
    /// </summary>
    internal const double TiltScrollStepPx = 45;

    /// <summary>
    /// Maps a tilt delta to a scrollLeft increment in CSS pixels. Right tilt
    /// (positive delta) scrolls right — towards the newer dates. High-resolution
    /// wheels report multiples/smooth fractions of WHEEL_DELTA, so scale
    /// proportionally. Returns null for delta == 0 (no tilt).
    /// </summary>
    public static double? ComputeScrollDeltaPx(int delta)
    {
        if (delta == 0) return null;
        return delta / WheelDelta * TiltScrollStepPx;
    }

    /// <summary>
    /// Unpacks the signed wheel delta from wParam's high word — the
    /// GET_WHEEL_DELTA_WPARAM macro's arithmetic. Positive = right tilt.
    /// </summary>
    public static int ExtractWheelDelta(nint wParam) =>
        (short)((wParam.ToInt64() >> 16) & 0xFFFF);

    /// <summary>
    /// Unpacks the signed screen x/y from lParam's low/high 16-bit words
    /// (negative values are normal on multi-monitor layouts left of the origin).
    /// </summary>
    public static (double X, double Y) ExtractScreenPoint(nint lParam) =>
        ((short)(lParam.ToInt64() & 0xFFFF), (short)((lParam.ToInt64() >> 16) & 0xFFFF));

    /// <summary>
    /// Builds the scroll-injection script for one tilt tick, or null when the
    /// tick must be dropped: core not ready / app exiting (no live page) or a
    /// zero delta. The host re-checks the same guards so a guarded tick stays
    /// fully unhandled instead of being swallowed.
    /// </summary>
    public static string? BuildScrollScript(bool coreReady, bool exiting, int delta, double x, double y)
    {
        if (exiting || !coreReady) return null;
        var deltaPx = ComputeScrollDeltaPx(delta);
        if (deltaPx is not { } px) return null;
        return ScriptTemplate
            .Replace("{X}", FormatNumber(x))
            .Replace("{Y}", FormatNumber(y))
            .Replace("{D}", FormatNumber(px));
    }

    // Invariant culture matters: with a comma-decimal locale string.Format would
    // emit "512,5", which is not a JS numeric literal.
    private static string FormatNumber(double value) =>
        value.ToString("0.###", CultureInfo.InvariantCulture);

    // Hit-test the hovered point, then walk up to the nearest ancestor that
    // actually overflows horizontally (scrollWidth > clientWidth) and auto/scrolls
    // on the x axis — the heatmap's scroll container qualifies; overflow:hidden
    // shells (the native main card) do not. Returns false (and does nothing) when
    // no such ancestor exists, e.g. no horizontal scrollbar at all. Stateless by
    // design: every tilt re-hit-tests, so hovering off the heatmap naturally
    // disengages it.
    private const string ScriptTemplate =
        "(function(x,y,d){var el=document.elementFromPoint(x,y);" +
        "while(el&&el!==document.body){" +
        "if(el.scrollWidth>el.clientWidth+1&&/(auto|scroll)/.test(getComputedStyle(el).overflowX)){" +
        "el.scrollLeft+=d;return true;}" +
        "el=el.parentElement;}" +
        "return false;})({X}, {Y}, {D})";
}
