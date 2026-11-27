namespace TokenTrackerWin;

/// <summary>
/// Pure geometry behind the dashboard window's maximize placement. Borderless
/// WPF windows (<c>WindowStyle.None</c> + custom <c>WindowChrome</c>) let
/// <c>WindowState.Maximized</c> fill the full monitor (<c>rcMonitor</c>) and
/// cover a visible taskbar. The host intercepts <c>WM_GETMINMAXINFO</c>
/// (0x0024) and writes <c>ptMaxPosition</c> / <c>ptMaxSize</c> from this
/// helper so maximize (button, Aero snap, Win+Up) fits the current monitor's
/// work area (<c>rcWork</c>).
///
/// <c>rcWork</c> already respects auto-hide (it equals <c>rcMonitor</c> when
/// the taskbar is hidden, so the window fills the screen and the taskbar can
/// slide over it) and is reported in device pixels, matching
/// <c>MINMAXINFO</c> and the host's PerMonitorV2 DPI awareness. Kept free of
/// UI / P/Invoke dependencies so the placement arithmetic is unit testable
/// (same style as <see cref="TiltWheelScrollForwarder"/>).
/// </summary>
internal static class MaximizedWorkArea
{
    /// <summary>A monitor or work-area rectangle in screen device pixels.</summary>
    internal readonly record struct ScreenRect(int Left, int Top, int Right, int Bottom)
    {
        public int Width => Right - Left;
        public int Height => Bottom - Top;
    }

    /// <summary>
    /// Maximized placement relative to the monitor origin: <c>ptMaxPosition</c>
    /// is the offset of the work area from the monitor's top-left, and
    /// <c>ptMaxSize</c> is the work area's size — never the full <c>rcMonitor</c>
    /// when a visible taskbar shrinks <c>rcWork</c>.
    /// </summary>
    internal readonly record struct Placement(int PositionX, int PositionY, int SizeX, int SizeY);

    /// <summary>
    /// Computes the maximized position and size that fill <paramref name="work"/>
    /// on <paramref name="monitor"/>. Returns false when the work area is empty
    /// or inverted, so the caller can leave the default <c>MINMAXINFO</c> alone.
    /// </summary>
    public static bool TryCompute(ScreenRect work, ScreenRect monitor, out Placement placement)
    {
        var width = work.Width;
        var height = work.Height;
        if (width <= 0 || height <= 0)
        {
            placement = default;
            return false;
        }

        // ptMaxPosition is relative to the monitor, not the virtual-screen
        // origin: a display left of the primary reports negative screen
        // coordinates, but the maximized offset on that display is still
        // (work - monitor), usually (0, 0) or a positive taskbar inset.
        placement = new Placement(
            PositionX: work.Left - monitor.Left,
            PositionY: work.Top - monitor.Top,
            SizeX: width,
            SizeY: height);
        return true;
    }
}
