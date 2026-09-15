using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace TokenTrackerWin;

/// <summary>
/// A small, always-on-top floating widget showing ONLY the animated "Clawd"
/// companion — the Windows desktop counterpart of the mascot the macOS app shows
/// in its menu-bar popover (the taskbar can't host an animated icon, so we float
/// the sprite directly on the desktop).
///
/// Transparency: this is a WPF <b>layered</b> window (<see cref="Window.AllowsTransparency"/>
/// = true, <see cref="WindowStyle"/> = None, transparent background) hosting a
/// <see cref="WebView2CompositionControl"/> (DirectComposition / windowless). The
/// composition surface's per-pixel alpha is honoured by the layered window, so only
/// the sprite's opaque pixels show and everything around it is fully see-through to
/// the desktop — no frame, no frosted box.
///
/// There is no chrome: only the pet sprite is mouse-active, while transparent padding
/// passes clicks to the desktop or app underneath. The page decides what a press on the
/// pet means (<c>pet:drag</c> → native window move, tap → animation, right-click →
/// <c>pet:open-dashboard</c>). Closing hides the window; the app exits via the tray
/// "Quit" → <see cref="Shutdown"/>.
/// </summary>
internal sealed class PetWindow : Window
{
    // Windowless (DirectComposition) hosting — the only WPF WebView2 variant that
    // renders a genuinely transparent surface. AllowExternalDrop must be off
    // (windowless hosting throws on init otherwise).
    private readonly WebView2CompositionControl _webView = new() { AllowExternalDrop = false };
    private readonly ServerManager _server;
    private readonly System.Windows.Threading.DispatcherTimer _saveTimer;
    private readonly System.Windows.Threading.DispatcherTimer _hoverTimer;
    private readonly System.Windows.Threading.DispatcherTimer _clickThroughTimer;
    private bool _lastHover;
    private int _lastLookDirection = -1;
    private bool _clickThrough;
    private bool _typing;
    private long _lastKeyTick;
    private long _typingStreakStart;  // when the current unbroken typing streak began (0 = not typing)
    private long _rageUntil;          // TickCount until which the overheated "error" gag shows
    private bool _rage;
    private bool _coreReady;
    private bool _exiting;
    private nint _hwnd;
    private string _curSymbol = "$";
    private decimal _curRate = 1m;
    private string _locale = "en";
    private bool _syncing;
    private JsonNode? _limits;
    private string _character = CurrentCharacter;
    private string _botColor = CurrentBotColor;
    private UsagePoller.UsageStats _stats;
    private bool _connected = true;
    private double _bubbleBand = MinBubbleBand;
    private bool _isAdjustingBubbleLayout;
    private bool _isDragging;
    private double _lastDragLeft;
    private bool _isAnimating;
    private EventHandler? _renderHandler;
    private System.Diagnostics.Stopwatch? _animStopwatch;
    private double _animStartX;
    private double _animTargetX;

    // Snapping / Mini mode states
    private bool _miniMode;
    private bool _isRevealed;
    private double _preMiniX;
    private double _preMiniY;
    private const double EdgePeek = 30;
    private const double SnapMargin = 24;
    private const double EdgeTolerance = 4.0;

    // Mouse idle / wake tracking
    private POINT _lastMousePos;
    private long _lastMouseActiveTime;
    private bool _mouseIdle;

    /// <summary>Raised (on the UI thread) when the user right-clicks the pet — the host shows a context menu.</summary>
    public event Action? ContextMenuRequested;

    public PetWindow(ServerManager server)
    {
        _server = server;

        // Seed the currency from the native cache so the very first push (on page load)
        // already carries the app's last-used unit — no USD flash before the tray's
        // RefreshSummary lands, and correct even when the dashboard was never opened.
        if (Currency.ReadPersisted() is { } cached)
        {
            _curSymbol = cached.Symbol;
            _curRate = cached.Rate;
        }

        Title = Constants.AppDisplayName + " Pet";
        var (w, h) = SizeDimensions(CurrentSize);
        Width = w;
        Height = h;
        WindowStyle = WindowStyle.None;          // no OS chrome
        ResizeMode = ResizeMode.NoResize;
        // Per-pixel transparency: layered window whose alpha comes from the
        // (transparent) WebView2 composition surface. Must be set before the handle
        // is created — i.e. here in the constructor, before the window is shown.
        AllowsTransparency = true;
        Background = System.Windows.Media.Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;                   // floating — don't steal focus from the active app

        RestorePlacement();

        Content = _webView;

        // Persist the position shortly after a drag settles (LocationChanged fires
        // continuously during an OS move).
        _saveTimer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(500),
        };
        _saveTimer.Tick += (_, _) => { _saveTimer.Stop(); SavePlacement(); };
        LocationChanged += (_, _) =>
        {
            if (_isAdjustingBubbleLayout) return;
            UpdateDragDirectionFromWindowMove();
            _saveTimer.Stop();
            _saveTimer.Start();
        };

        // WebView2 does not reliably deliver mouse-leave to this transparent, never-
        // activated topmost window, so the page's own hover detection sticks. Poll the
        // OS cursor vs the window rect instead and push the hover state to the page.
        _hoverTimer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(150),
        };
        _hoverTimer.Tick += (_, _) => { HoverTick(); TypingTick(); };

        // WS_EX_TRANSPARENT is window-wide, so poll the OS cursor and apply it only
        // while the pointer is over transparent padding. This preserves interaction
        // with the pet while allowing padding clicks to reach other processes.
        // 50ms (20Hz) is imperceptible for hover/click hand-off and keeps the pet
        // from waking the dispatcher 60x/s for its entire visible lifetime.
        _clickThroughTimer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(50),
        };
        _clickThroughTimer.Tick += (_, _) => ClickThroughTick();

        Loaded += OnLoaded;
        _server.StatusChanged += OnServerStatusChanged;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await InitializeWebViewAsync();
        }
        catch (Exception ex)
        {
            // WebView2 initialization runs from an async-void WPF event. Keep a
            // renderer/profile failure from terminating the tray host; the pet can
            // remain hidden while the dashboard and server continue to recover.
            Diag.Log("pet", $"webview initialization failed: {ex}");
        }
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        _hwnd = new WindowInteropHelper(this).Handle;
        _clickThrough = (GetWindowExStyle(_hwnd).ToInt64() & WS_EX_TRANSPARENT) != 0;
        ClickThroughTick();
    }

    private bool IsPointOnPet(System.Windows.Point screenPoint)
    {
        try
        {
            if (ActualWidth <= 0 || ActualHeight <= 0) return true;

            var p = PointFromScreen(screenPoint);
            if (p.X < 0 || p.Y < 0 || p.X >= ActualWidth || p.Y >= ActualHeight) return false;

            // The WebView2 surface is rectangular even though most of it is transparent.
            // Keep only the lower centered sprite square mouse-active; clicks on the
            // bubble band or horizontal padding should pass through to whatever is behind.
            double spriteSize = SpriteSizeFor(ActualWidth, ActualHeight, _bubbleBand);
            double pad = Math.Max(8, spriteSize * 0.08);
            double left = (ActualWidth - spriteSize) / 2 - pad;
            double right = left + spriteSize + (pad * 2);
            double top = _bubbleBand - pad;
            double bottom = Math.Min(ActualHeight, _bubbleBand + spriteSize + pad);

            return p.X >= left && p.X <= right && p.Y >= top && p.Y <= bottom;
        }
        catch
        {
            // If layout or DPI transforms are temporarily unavailable, prefer the old
            // behaviour over making the pet impossible to interact with.
            return true;
        }
    }

    private void ClickThroughTick()
    {
        // Skip while dragging or sliding: recomputing IsPointOnPet against the moving
        // window would thrash WS_EX_TRANSPARENT and issue a SWP_FRAMECHANGED (non-client
        // recalc + redraw) on every poll, fighting the edge slide and making it stutter.
        if (!IsVisible || _hwnd == nint.Zero || _isDragging || _isAnimating || !GetCursorPos(out var cursor)) return;
        SetClickThrough(!IsPointOnPet(new System.Windows.Point(cursor.X, cursor.Y)));
    }

    private void SetClickThrough(bool enabled)
    {
        if (_hwnd == nint.Zero || enabled == _clickThrough) return;

        long style = GetWindowExStyle(_hwnd).ToInt64();
        long updatedStyle = enabled
            ? style | WS_EX_TRANSPARENT
            : style & ~WS_EX_TRANSPARENT;
        SetWindowExStyle(_hwnd, (nint)updatedStyle);

        long appliedStyle = GetWindowExStyle(_hwnd).ToInt64();
        if (((appliedStyle & WS_EX_TRANSPARENT) != 0) != enabled) return;

        _clickThrough = enabled;
        SetWindowPos(
            _hwnd,
            nint.Zero,
            0,
            0,
            0,
            0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }

    private async Task InitializeWebViewAsync()
    {
        if (_coreReady) return;

        // Own user-data folder (separate from the dashboard's) so the two WebView2
        // environments never clash over differing creation options.
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "TokenTracker", "WebView2Pet");
        Directory.CreateDirectory(userDataFolder);

        // Transparent composition surface; must be set before the browser process starts.
        // Only alpha 0 (transparent) or 255 are supported.
        Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0");

        var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder, null);
        await _webView.EnsureCoreWebView2Async(env);
        _coreReady = true;

        _webView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0, 0, 0, 0);

        var core = _webView.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.ProcessFailed += (_, e) =>
            Diag.Log("pet", $"webview process failed kind={e.ProcessFailedKind}");

        // Keep the surface transparent even before the page's own CSS lands.
        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            "try{var s=document.createElement('style');" +
            "s.textContent='html,body,#pet-root{background:transparent!important}';" +
            "(document.head||document.documentElement).appendChild(s);}catch(e){}");

        core.WebMessageReceived += (_, e) =>
        {
            string msg;
            try { msg = e.TryGetWebMessageAsString(); }
            catch { return; }

            switch (msg)
            {
                case string bubbleMessage when bubbleMessage.StartsWith("pet:bubble-height:", StringComparison.Ordinal):
                {
                    var rawHeight = bubbleMessage["pet:bubble-height:".Length..];
                    if (double.TryParse(rawHeight, NumberStyles.Float, CultureInfo.InvariantCulture, out var height))
                    {
                        ApplyBubbleBand(height);
                    }
                    break;
                }
                case "pet:drag":
                case "pet:drag-left":
                case "pet:drag-right":
                {
                    // Hand the press off to the OS so the borderless window moves natively.
                    // finally guarantees _isDragging resets even if the modal move loop
                    // throws; a stuck true would permanently disable hover/click-through
                    // ticks and placement saves.
                    _isDragging = true;
                    _lastDragLeft = Left;
                    PushDragState(msg == "pet:drag-left" ? "running-left" : "running-right");
                    try
                    {
                        StopEdgeAnimation();
                        ReleaseCapture();
                        SendMessage(_hwnd, WM_NCLBUTTONDOWN, (nint)HTCAPTION, nint.Zero);
                    }
                    finally
                    {
                        _isDragging = false;
                        PushDragState(null);
                    }
                    // Settle placement synchronously, right here on the UI thread, before
                    // any DispatcherTimer tick can run. Deferring to the 500ms _saveTimer
                    // would let HoverTick fire first while _miniMode is still true; its
                    // edge-anchored reveal/tuck would snap the window back to the right
                    // edge, so SavePlacement would then always see it at the edge and the
                    // pet could never leave mini mode. Running it now also covers the
                    // "release without a final move fires no LocationChanged" case.
                    _saveTimer.Stop();
                    SavePlacement();
                    break;
                }
                case "pet:context-menu":
                    ContextMenuRequested?.Invoke();
                    break;
            }
        };

        // Re-push currency + locale after every (re)load so the bubble + quips match
        // the app's unit/language even across navigations.
        core.NavigationCompleted += (_, _) => PushContext();

        NavigateWhenServerReady();
    }

    private void OnServerStatusChanged(ServerManager.ServerStatus status)
    {
        if (status != ServerManager.ServerStatus.Running) return;
        try { Dispatcher.BeginInvoke(new Action(NavigateWhenServerReady)); }
        catch { /* window is closing */ }
    }

    private void NavigateWhenServerReady()
    {
        if (!_coreReady || _server.Status != ServerManager.ServerStatus.Running) return;
        _webView.CoreWebView2.Navigate(_server.BaseUrl + "/pet.html?app=1");
    }

    // ── Public API ─────────────────────────────────────────────────────

    public void ShowPet()
    {
        if (!IsVisible) Show();
        Topmost = true;
        _hoverTimer.Start();
        _clickThroughTimer.Start();
        ClickThroughTick();
    }

    public void HidePet()
    {
        _isDragging = false;
        PushDragState(null);
        _clickThroughTimer.Stop();
        StopEdgeAnimation();
        SetClickThrough(false);
        Hide();
        _hoverTimer.Stop();
        _lastHover = false;
        PushHover(false);
        _typing = false; // re-evaluated on next show
        _rage = false;
        _typingStreakStart = 0;
    }

    private void HoverTick()
    {
        if (!IsVisible || !_coreReady || _isDragging) return;
        if (!GetCursorPos(out var p)) return;

        // Global mouse movement & sleep/wake sequence
        long now = Environment.TickCount64;
        bool moved = p.X != _lastMousePos.X || p.Y != _lastMousePos.Y;
        if (moved)
        {
            _lastMousePos = p;
            _lastMouseActiveTime = now;
            if (_mouseIdle)
            {
                _mouseIdle = false;
                _ = _webView.CoreWebView2.ExecuteScriptAsync(
                    "window.dispatchEvent(new CustomEvent('pet:wake'));");
            }
        }
        else
        {
            long idleDuration = now - _lastMouseActiveTime;
            if (!_mouseIdle && idleDuration >= 60000)
            {
                _mouseIdle = true;
                _ = _webView.CoreWebView2.ExecuteScriptAsync(
                    "window.dispatchEvent(new CustomEvent('pet:sleep', { detail: { phase: 'sleeping' } }));");
            }
        }

        bool inside;
        try
        {
            var tl = PointToScreen(new System.Windows.Point(0, 0));
            double pad = Math.Max(8, SpriteSize * 0.08);
            double spriteTop = tl.Y + _bubbleBand - pad;
            double spriteBottom = tl.Y + _bubbleBand + SpriteSize + pad;
            if (_miniMode)
            {
                // Anchor the hover test to the *target* geometry (both peek and revealed
                // states hug the right work-area edge), NOT the live window X, which is
                // mid-slide during ApplyEdgePlacement. Reading the moving rect here would
                // let the inside/outside result flip against the animating edge and re-
                // toggle _isRevealed, cancelling and restarting the slide — the retract
                // stutter. Using _isRevealed as the reference gives stable hysteresis:
                // tucked → only the peek strip is "inside"; revealed → the whole slid-out
                // band up to the screen edge is.
                var wa = SystemParameters.WorkArea;
                double targetLeft = _isRevealed ? wa.Right - Width : TuckedLeft(wa.Right);
                double leftX = targetLeft + SpriteLeftInset - pad;
                double rightLimit = wa.Right + EdgeTolerance; // cursor clamps at the screen edge
                // Both states must share the border strip, or the hysteresis above has no
                // dead zone. Capping the revealed state at spriteRight looks right but is
                // not: the sprite is centred in a 400px window, so its right edge sits
                // ~137px inside the screen edge. A cursor parked on the border was then
                // "inside" while tucked (that region runs to rightLimit) and "outside"
                // once revealed — reveal, tuck, reveal, every 150ms hover tick, with
                // _isAnimating stuck true so ClickThroughTick never restored
                // WS_EX_TRANSPARENT and the pet could not be grabbed (#434). Running the
                // revealed region to the same rightLimit makes it a superset of the
                // tucked one: hovering the border keeps the pet out, and it tucks only
                // when the cursor leaves the sprite band.
                inside = p.X >= leftX && p.X < rightLimit
                    && p.Y >= spriteTop && p.Y < spriteBottom;
            }
            else
            {
                double spriteLeft = tl.X + SpriteLeftInset - pad;
                double spriteRight = tl.X + SpriteLeftInset + SpriteSize + pad;
                inside = p.X >= spriteLeft && p.X < spriteRight
                    && p.Y >= spriteTop && p.Y < spriteBottom;
            }
        }
        catch { return; }   // not laid out yet

        // V2 atlases expose sixteen cursor-facing cells at 22.5° increments. Push the
        // global cursor direction even when it is outside the transparent pet window,
        // matching the Codex Pets cursor preview and the macOS native companion.
        try
        {
            var center = PointToScreen(new System.Windows.Point(ActualWidth / 2, (_bubbleBand + ActualHeight) / 2));
            double dx = p.X - center.X;
            double dy = p.Y - center.Y; // screen coordinates grow downward
            double degrees = (Math.Atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
            int direction = ((int)Math.Round(degrees / 22.5)) % 16;
            if (direction != _lastLookDirection)
            {
                _lastLookDirection = direction;
                _ = _webView.CoreWebView2.ExecuteScriptAsync(
                    $"window.__ttPetLookDirectionIndex={direction};" +
                    "window.dispatchEvent(new Event('pet:look'));"
                );
            }
        }
        catch { /* window transform unavailable during resize/navigation */ }

        if (_miniMode)
        {
            if (inside && !_isRevealed)
            {
                _isRevealed = true;
                ApplyEdgePlacement(animated: true);
            }
            else if (!inside && _isRevealed)
            {
                _isRevealed = false;
                ApplyEdgePlacement(animated: true);
            }
        }

        if (inside == _lastHover) return;
        _lastHover = inside;
        PushHover(inside);
    }

    private void PushHover(bool hovering)
    {
        if (!_coreReady) return;
        try
        {
            _ = _webView.CoreWebView2.ExecuteScriptAsync(
                $"window.__ttPetHover={(hovering ? "true" : "false")};" +
                "window.dispatchEvent(new Event('pet:hover'));");
        }
        catch { /* page mid-navigation */ }
    }

    private void ApplyBubbleBand(double requestedHeight)
    {
        if (!double.IsFinite(requestedHeight)) return;

        var baseHeight = BaseHeightFor(CurrentSize);
        var spriteAreaHeight = baseHeight - MinBubbleBand;
        var workArea = SystemParameters.WorkArea;
        var maxBand = Math.Max(MinBubbleBand, workArea.Height - spriteAreaHeight);
        var nextBand = Math.Clamp(Math.Ceiling(requestedHeight), MinBubbleBand, maxBand);
        if (Math.Abs(nextBand - _bubbleBand) < 0.5) return;

        var oldBottom = Top + Height;
        _isAdjustingBubbleLayout = true;
        try
        {
            _bubbleBand = nextBand;
            Height = baseHeight + (_bubbleBand - MinBubbleBand);
            if (!double.IsNaN(oldBottom))
            {
                Top = Math.Max(workArea.Top, Math.Min(oldBottom - Height, workArea.Bottom - Height));
            }
        }
        finally { _isAdjustingBubbleLayout = false; }
        PushBubbleBand();
        if (_miniMode) ApplyEdgePlacement(animated: false);
    }

    private void PushBubbleBand()
    {
        if (!_coreReady) return;
        try
        {
            var value = _bubbleBand.ToString(CultureInfo.InvariantCulture);
            _ = _webView.CoreWebView2.ExecuteScriptAsync(
                $"window.__ttPetBubbleBand={value};" +
                "window.dispatchEvent(new Event('pet:bubble-band'));");
        }
        catch { /* page mid-navigation */ }
    }

    private void UpdateDragDirectionFromWindowMove()
    {
        if (!_isDragging || double.IsNaN(Left)) return;
        var deltaX = Left - _lastDragLeft;
        if (Math.Abs(deltaX) < 0.5) return;
        _lastDragLeft = Left;
        PushDragState(deltaX < 0 ? "running-left" : "running-right");
    }

    private void PushDragState(string? state)
    {
        if (!_coreReady) return;
        try
        {
            var value = System.Text.Json.JsonSerializer.Serialize(state);
            _ = _webView.CoreWebView2.ExecuteScriptAsync(
                $"window.__ttPetDragState={value};" +
                "window.dispatchEvent(new Event('pet:drag-state'));" +
                (state is null ? "window.dispatchEvent(new Event('pet:drag-end'));" : ""));
        }
        catch { /* page mid-navigation */ }
    }

    // ── Typing activity (global, count-only) ───────────────────────────────
    //
    // Drives the "typing" animation while the user is actually typing — anywhere. We
    // poll a curated set of typing virtual-keys for "pressed since the previous call"
    // and only use that to reset a linger timer. This detects THAT the user is typing,
    // never WHICH keys (no content is read or stored), in line with the project's
    // token-counts-only privacy rule. Mouse buttons + modifiers are excluded so clicks
    // and Ctrl/Shift alone don't count.
    // Short enough that the animation stops ~immediately after you stop typing, but long
    // enough to bridge the all-keys-up gaps between keystrokes so it doesn't flicker mid-type.
    private const long TypingLingerMs = 400;
    // The overheat streak is more forgiving than the animation linger: a brief thinking
    // pause shouldn't reset your 30s of furious typing.
    private const long RageStreakGapMs = 1500;
    private const long RageTriggerMs = 30_000; // unbroken typing before Clawd "overheats"
    private const long RageShowMs = 5_000;     // how long the overheated "error" gag plays

    private void TypingTick()
    {
        long now = Environment.TickCount64;
        if (AnyTypingKeyPressed()) _lastKeyTick = now;
        long sinceKey = now - _lastKeyTick;
        bool typing = sinceKey < TypingLingerMs;

        if (typing != _typing) { _typing = typing; PushState("Typing", typing); }

        // Type non-stop for RageTriggerMs and Clawd overheats: it plays the "error" pose
        // (fanning itself / steaming) for RageShowMs, then resets — another full streak of
        // continuous typing is needed before it can trigger again.
        if (_rage)
        {
            if (now >= _rageUntil) { _rage = false; _typingStreakStart = 0; PushState("Rage", false); }
        }
        else if (sinceKey < RageStreakGapMs) // streak survives brief thinking pauses
        {
            if (_typingStreakStart == 0) _typingStreakStart = now;
            else if (now - _typingStreakStart >= RageTriggerMs)
            {
                _rage = true;
                _rageUntil = now + RageShowMs;
                PushState("Rage", true);
            }
        }
        else
        {
            _typingStreakStart = 0; // streak broken
        }
    }

    /// <summary>Set a boolean <c>window.__ttPet&lt;name&gt;</c> flag + dispatch <c>pet:&lt;name lower&gt;</c>.</summary>
    private void PushState(string name, bool value)
    {
        if (!_coreReady) return;
        try
        {
            _ = _webView.CoreWebView2.ExecuteScriptAsync(
                $"window.__ttPet{name}={(value ? "true" : "false")};" +
                $"window.dispatchEvent(new Event('pet:{name.ToLowerInvariant()}'));");
        }
        catch { /* page mid-navigation */ }
    }

    private static bool AnyTypingKeyPressed()
    {
        static bool Hit(int vk) => (GetAsyncKeyState(vk) & 0x0001) != 0; // pressed since last call
        for (int vk = 0x41; vk <= 0x5A; vk++) if (Hit(vk)) return true;  // A–Z
        for (int vk = 0x30; vk <= 0x39; vk++) if (Hit(vk)) return true;  // 0–9
        for (int vk = 0x60; vk <= 0x6F; vk++) if (Hit(vk)) return true;  // numpad 0–9 / operators
        foreach (int vk in TypingKeys) if (Hit(vk)) return true;
        return false;
    }

    // space, enter, backspace, tab, and the OEM punctuation keys (; = , - . / ` [ \ ] ').
    private static readonly int[] TypingKeys =
    {
        0x20, 0x0D, 0x08, 0x09,
        0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xC0,
        0xDB, 0xDC, 0xDD, 0xDE,
    };

    /// <summary>
    /// Push the resolved currency (symbol + USD→currency rate, read by the host
    /// from the dashboard) into the pet page so its hover bubble matches the app.
    /// </summary>
    public void ApplyCurrency(string symbol, decimal rate)
    {
        _curSymbol = string.IsNullOrEmpty(symbol) ? "$" : symbol;
        _curRate = rate > 0 ? rate : 1m;
        PushContext();
    }

    /// <summary>Push the resolved UI locale so the pet's tap quips match the app's language.</summary>
    public void ApplyLocale(string locale)
    {
        _locale = string.IsNullOrWhiteSpace(locale) ? "en" : locale;
        PushContext();
    }

    /// <summary>Push whether a sync is in progress (drives the "typing" animation, like macOS).</summary>
    public void ApplySyncing(bool syncing)
    {
        _syncing = syncing;
        PushContext();
    }

    /// <summary>Push the native usage-limits snapshot without letting raw JSON become executable script.</summary>
    public void ApplyLimits(string? json)
    {
        try
        {
            _limits = string.IsNullOrWhiteSpace(json) ? null : JsonNode.Parse(json);
        }
        catch
        {
            // Keep the last good snapshot if a provider returns malformed data.
            return;
        }
        PushContext();
    }

    /// <summary>
    /// Push the usage stats (the SAME numbers the tray's UsagePoller fetched) so the
    /// pet's bubble + animation tier + data-rich quip pool always match the tray exactly
    /// — no independent polling, no drift. Today's tokens/cost drive the hover bubble and
    /// animation tier; the rolling / heatmap / top-model figures feed the quip pool
    /// (mirroring the macOS companion).
    /// </summary>
    public void ApplyStats(UsagePoller.UsageStats stats)
    {
        var prevTokens = _stats.TodayTokens;
        var prevCost = _stats.TodayCostUsd;
        _stats = stats;
        if (prevTokens > 0 && stats.TodayTokens > prevTokens)
        {
            long tokensDelta = stats.TodayTokens - prevTokens;
            decimal costDelta = stats.TodayCostUsd - prevCost;
            if (_coreReady)
            {
                var modelName = "AI Model";
                var costDeltaJs = costDelta.ToString(System.Globalization.CultureInfo.InvariantCulture);
                _ = _webView.CoreWebView2.ExecuteScriptAsync(
                    $"window.dispatchEvent(new CustomEvent('pet:model-status', {{ detail: {{ modelName: '{modelName}', tokensDelta: {tokensDelta}, costDelta: {costDeltaJs} }} }}));");
            }
        }
        PushContext();
    }

    /// <summary>Push whether the local server is reachable (drives the disconnected animation).</summary>
    public void ApplyConnected(bool connected)
    {
        _connected = connected;
        PushContext();
    }

    private void PushContext()
    {
        if (!_coreReady) return;
        var inv = System.Globalization.CultureInfo.InvariantCulture;
        var sym = System.Text.Json.JsonSerializer.Serialize(_curSymbol);
        var rate = _curRate.ToString(inv);
        var loc = System.Text.Json.JsonSerializer.Serialize(_locale);
        var character = System.Text.Json.JsonSerializer.Serialize(_character);
        var botColor = System.Text.Json.JsonSerializer.Serialize(_botColor);
        // The pet host renders without ThemeProvider, so nothing there can resolve the
        // appearance on its own. Without this the bot's default "auto" body colour is
        // stuck on the light value — a near-black blob on a dark desktop.
        var petDark = NativeTheme.ResolveIsLight(NativeTheme.CurrentPreference) ? "false" : "true";
        var syncing = _syncing ? "true" : "false";
        var cost = _stats.CostPartial ? "—" : _stats.TodayCostUsd.ToString(inv);
        var limitsJson = _limits?.ToJsonString() ?? "null";
        var bubbleBand = _bubbleBand.ToString(inv);
        var connected = _connected ? "true" : "false";
        var statsJson = System.Text.Json.JsonSerializer.Serialize(new
        {
            todayTokens = _stats.TodayTokens,
            todayCostUsd = _stats.CostPartial ? (decimal?)null : _stats.TodayCostUsd,
            costPartial = _stats.CostPartial,
            conversations = _stats.TodayConversations,
            last7dTokens = _stats.Last7dTokens,
            last7dActiveDays = _stats.Last7dActiveDays,
            last30dTokens = _stats.Last30dTokens,
            last30dAvgPerDay = _stats.Last30dAvgPerDay,
            streakDays = _stats.StreakDays,
            activeDaysAllTime = _stats.ActiveDaysAllTime,
            topModels = (_stats.TopModels ?? Array.Empty<UsagePoller.TopModelStat>())
                .Select(m => new { name = m.Name, percent = m.Percent, source = m.Source }),
        });
        var mini = _miniMode ? "true" : "false";
        var lookDirection = _lastLookDirection >= 0 ? _lastLookDirection.ToString() : "null";
        try
        {
            _ = _webView.CoreWebView2.ExecuteScriptAsync(
                $"window.__ttPetCurrency={{symbol:{sym},rate:{rate}}};" +
                $"window.__ttPetLocale={loc};" +
                $"window.__ttPetCharacter={character};" +
                $"window.__ttPetBotColor={botColor};" +
                $"window.__ttPetDark={petDark};" +
                $"window.__ttPetLookDirectionIndex={lookDirection};" +
                $"window.__ttPetSyncing={syncing};" +
                $"window.__ttPetTokens={_stats.TodayTokens};" +
                $"window.__ttPetCostUsd={cost};" +
                $"window.__ttPetStats={statsJson};" +
                $"window.__ttPetLimits={limitsJson};" +
                $"window.__ttPetBubbleBand={bubbleBand};" +
                $"window.__ttPetConnected={connected};" +
                $"window.__ttPetMiniMode={mini};" +
                "window.dispatchEvent(new Event('pet:currency'));" +
                "window.dispatchEvent(new Event('pet:locale'));" +
                "window.dispatchEvent(new Event('pet:character'));" +
                "window.dispatchEvent(new Event('pet:botColor'));" +
                "window.dispatchEvent(new Event('pet:dark'));" +
                "window.dispatchEvent(new Event('pet:look'));" +
                "window.dispatchEvent(new Event('pet:syncing'));" +
                "window.dispatchEvent(new Event('pet:usage'));" +
                "window.dispatchEvent(new Event('pet:limits'));" +
                "window.dispatchEvent(new Event('pet:bubble-band'));" +
                "window.dispatchEvent(new Event('pet:connected'));" +
                "window.dispatchEvent(new Event('pet:minimode'));");
        }
        catch { /* page mid-navigation */ }
    }

    /// <summary>Resize the floating pet (small / medium / large) live + persist the choice.</summary>
    public void ApplySize(string size)
    {
        var normalized = NormalizeSize(size);
        var (w, h) = SizeDimensions(normalized);
        var oldBottom = Top + Height;
        Width = w;
        Height = h + (_bubbleBand - MinBubbleBand);
        if (!double.IsNaN(oldBottom)) Top = oldBottom - Height;
        if (_miniMode) ApplyEdgePlacement(animated: false);
        WriteSettings(s => s["PetSize"] = normalized);
    }

    /// <summary>Persist a size choice without a live window (used when the pet is closed).</summary>
    public static void PersistSize(string size)
    {
        var normalized = NormalizeSize(size);
        WriteSettings(s => s["PetSize"] = normalized);
    }

    /// <summary>Switch the visible companion identity and persist it.</summary>
    public void ApplyCharacter(string character)
    {
        _character = NormalizeCharacter(character);
        WriteSettings(s => s["PetCharacter"] = _character);
        PushContext();
    }

    /// <summary>Persist a character choice without creating the floating window.</summary>
    public static void PersistCharacter(string character)
    {
        var normalized = NormalizeCharacter(character);
        WriteSettings(s => s["PetCharacter"] = normalized);
    }

    /// <summary>Body colour for the vector `bot` character ("auto" follows the theme).</summary>
    public void ApplyBotColor(string colorId)
    {
        _botColor = NormalizeBotColor(colorId);
        WriteSettings(s => s["PetBotColor"] = _botColor);
        PushContext();
    }

    public static void PersistBotColor(string colorId)
    {
        WriteSettings(s => s["PetBotColor"] = NormalizeBotColor(colorId));
    }

    /// Validated web-side against the palette shipped with the engine; here we only
    /// keep it to a short slug so a bad value cannot become script.
    private static string NormalizeBotColor(string? colorId)
    {
        var value = (colorId ?? string.Empty).Trim().ToLowerInvariant();
        if (value.Length == 0 || value.Length > 32) return "auto";
        foreach (var c in value)
        {
            if (!(char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-')) return "auto";
        }
        return value;
    }

    public static string CurrentBotColor
    {
        get
        {
            try
            {
                if (!File.Exists(SettingsPath)) return "auto";
                var s = JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject();
                return NormalizeBotColor(s?["PetBotColor"]?.GetValue<string>());
            }
            catch { return "auto"; }
        }
    }

    public void TogglePet()
    {
        if (IsVisible) HidePet();
        else ShowPet();
    }

    /// <summary>Really close + tear down (called from the tray "Quit").</summary>
    public void Shutdown()
    {
        _exiting = true;
        Close();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        // Hide instead of close unless the app is exiting, so reopening is instant.
        if (!_exiting)
        {
            e.Cancel = true;
            HidePet();
            return;
        }
        SavePlacement();
        StopEdgeAnimation();
        _saveTimer.Stop();
        _hoverTimer.Stop();
        _clickThroughTimer.Stop();
        _server.StatusChanged -= OnServerStatusChanged;
        base.OnClosing(e);
    }

    // ── Placement persistence (native-settings.json) ───────────────────

    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TokenTracker", "native-settings.json");

    /// <summary>
    /// The persisted pet visibility, or null when the user has never toggled it.
    /// Null lets first launches fall back to the default (show on a manual run);
    /// an explicit false must survive restarts (issue #475).
    /// </summary>
    public static bool? StoredVisible
    {
        get
        {
            try
            {
                if (!File.Exists(SettingsPath)) return null;
                var s = JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject();
                return s?["PetVisible"]?.GetValue<bool>();
            }
            catch { return null; }
        }
    }

    public void StoreVisible(bool visible) => WriteSettings(s => s["PetVisible"] = visible);

    // ── Size (small / medium / large) ──────────────────────────────────
    //
    // Windows are a touch wider than tall so the hover bubble has room; the sprite
    // tracks the smaller (height) dimension.

    public const string SizeSmall = "small";
    public const string SizeMedium = "medium";
    public const string SizeLarge = "large";

    public const string CharacterClawd = "clawd";
    public const string CharacterBot = "bot";
    public const string CharacterSprout = "sprout";
    public const string CharacterByte = "byte";
    public const string CharacterEmber = "ember";
    private const string HiddenBuiltinsFilename = ".hidden-builtins.json";

    public static string NormalizeSize(string? value)
    {
        return (value ?? "").Trim().ToLowerInvariant() switch
        {
            SizeSmall => SizeSmall,
            SizeLarge => SizeLarge,
            _ => SizeMedium,
        };
    }

    public static string NormalizeCharacter(string? value)
    {
        var normalized = (value ?? "").Trim().ToLowerInvariant();
        if (normalized is CharacterSprout or CharacterByte or CharacterEmber
            && IsBuiltinCharacterHidden(normalized))
        {
            return CharacterClawd;
        }
        return normalized switch
        {
            CharacterSprout => CharacterSprout,
            CharacterByte => CharacterByte,
            CharacterEmber => CharacterEmber,
            CharacterClawd => CharacterClawd,
            CharacterBot => CharacterBot,
            _ when Regex.IsMatch(normalized, "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
                => normalized,
            _ => CharacterClawd,
        };
    }

    internal static bool IsBuiltinCharacterHidden(string character)
    {
        if (character is not (CharacterSprout or CharacterByte or CharacterEmber)) return false;
        try
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var file = Path.Combine(home, ".tokentracker", "pets", HiddenBuiltinsFilename);
            if (JsonNode.Parse(File.ReadAllText(file)) is not JsonArray ids) return false;
            return ids.Any(id => string.Equals(
                id?.GetValue<string>()?.Trim(),
                character,
                StringComparison.OrdinalIgnoreCase));
        }
        catch { return false; }
    }

    // The bubble starts at the macOS-parity compact height, then expands upward when
    // the WebView reports taller content. Keeping this value separate from the preset's
    // sprite area prevents dynamic rows from resizing the pet itself.
    private const double MinBubbleBand = 138;
    // The WebView surface must be wider than the 340px bubble so its border and
    // shadow never hit the layered-window edge. The extra area remains transparent
    // and click-through; the sprite stays centered at its original visual size.
    private const double WindowWidth = 400;

    // Keep the native edge geometry in lockstep with pet.jsx:sizeFor(). The window is
    // wider than the sprite so the bubble has room; hiding the window by a fixed number
    // of pixels would therefore hide only transparent horizontal padding.
    private static double SpriteSizeFor(double width, double height, double bubbleBand) => Math.Max(
        40,
        Math.Min(width, height - bubbleBand) - 8);
    private double SpriteSize => SpriteSizeFor(Width, Height, _bubbleBand);
    private double SpriteLeftInset => (Width - SpriteSize) / 2;
    private double SpriteRight(double windowLeft)
        => windowLeft + SpriteLeftInset + SpriteSize;

    private double TuckedLeft(double workAreaRight)
        => workAreaRight - SpriteLeftInset - EdgePeek;

    private static (double Width, double Height) SizeDimensions(string size) => size switch
    {
        SizeSmall => (WindowWidth, 230),
        SizeLarge => (WindowWidth, 286),
        _ => (WindowWidth, 254),
    };

    private static double BaseHeightFor(string size) => SizeDimensions(size).Height;

    // v0.81.2 persisted the top-left of the old narrow host. Use its width once
    // when migrating to center-based placement so the visible sprite does not jump.
    private static double LegacyWindowWidth(string size) => size switch
    {
        SizeSmall => 150,
        SizeLarge => 210,
        _ => 180,
    };

    /// <summary>The persisted size choice (defaults to medium).</summary>
    public static string CurrentSize
    {
        get
        {
            try
            {
                if (!File.Exists(SettingsPath)) return SizeMedium;
                var s = JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject();
                return NormalizeSize(s?["PetSize"]?.GetValue<string>());
            }
            catch { return SizeMedium; }
        }
    }

    public static string CurrentCharacter
    {
        get
        {
            try
            {
                if (!File.Exists(SettingsPath)) return CharacterClawd;
                var s = JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject();
                return NormalizeCharacter(s?["PetCharacter"]?.GetValue<string>());
            }
            catch { return CharacterClawd; }
        }
    }

    private void RestorePlacement()
    {
        WindowStartupLocation = WindowStartupLocation.Manual;
        var wa = SystemParameters.WorkArea;
        double left = wa.Right - Width - 24;
        double top = wa.Bottom - Height - 24;

        try
        {
            if (File.Exists(SettingsPath)
                && JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject() is { } s
                && s["PetY"]?.GetValue<double>() is { } y)
            {
                if (s["PetCenterX"]?.GetValue<double>() is { } centerX
                    && IsOnScreen(centerX - Width / 2, y, Width, Height))
                {
                    left = ClampXToVirtualScreen(centerX - Width / 2, Width);
                    top = ClampYToVirtualScreen(y, Height);
                }
                else if (s["PetX"]?.GetValue<double>() is { } legacyX)
                {
                    double migratedLeft = legacyX - (Width - LegacyWindowWidth(CurrentSize)) / 2;
                    if (IsOnScreen(legacyX, y, LegacyWindowWidth(CurrentSize), Height))
                    {
                        left = ClampXToVirtualScreen(migratedLeft, Width);
                        top = ClampYToVirtualScreen(y, Height);
                    }
                }
            }
        }
        catch { /* fall back to the default bottom-right anchor */ }

        Left = left;
        Top = top;
    }

    private void SavePlacement()
    {
        // The native drag's modal move loop keeps pumping messages, so the 500ms
        // _saveTimer can tick mid-drag. Bail then: snapping/ApplyEdgePlacement here would
        // start an edge animation that fights the OS drag and reintroduces the jitter.
        if (_isDragging) return;
        if (WindowState != WindowState.Normal) return;
        var x = Left;
        var y = Top;
        if (double.IsNaN(x) || double.IsNaN(y)) return;

        var wa = SystemParameters.WorkArea;
        // Snap to right edge of screen
        if (SpriteRight(x) >= wa.Right - SnapMargin)
        {
            if (!_miniMode)
            {
                _preMiniX = x;
                _preMiniY = y;
                _miniMode = true;
                _isRevealed = false;
                PushMiniMode(true);
            }
            ApplyEdgePlacement(animated: true);
        }
        else
        {
            if (_miniMode)
            {
                _miniMode = false;
                _isRevealed = false;
                PushMiniMode(false);
                // Return to normal layout y
                Left = x;
            }
            WriteSettings(s =>
            {
                s["PetX"] = x;
                s["PetCenterX"] = x + Width / 2;
                s["PetY"] = y;
            });
        }
    }

    private void PushMiniMode(bool value)
    {
        if (!_coreReady) return;
        try
        {
            _ = _webView.CoreWebView2.ExecuteScriptAsync(
                $"window.__ttPetMiniMode={(value ? "true" : "false")};" +
                $"window.dispatchEvent(new Event('pet:minimode'));");
        }
        catch { }
    }

    // Duration of the tuck/reveal slide. Time-based (not step-based) so the motion is
    // frame-rate independent.
    private const double EdgeAnimMs = 200.0;

    private void ApplyEdgePlacement(bool animated)
    {
        if (!_coreReady) return;

        // Cancel any in-flight slide before starting a new target.
        StopEdgeAnimation();

        var wa = SystemParameters.WorkArea;
        double targetX = _isRevealed ? wa.Right - Width : TuckedLeft(wa.Right);

        if (!animated)
        {
            Left = targetX;
            return;
        }

        _animStartX = Left;
        _animTargetX = targetX;
        if (Math.Abs(_animTargetX - _animStartX) < 1)
        {
            Left = targetX;
            return;
        }

        // Drive the slide off the composition (render) clock instead of Task.Delay: it
        // ticks once per WPF frame, vsync-paced, so the motion is smooth. A Task.Delay
        // loop rounds to the ~15.6ms OS timer quantum, producing the visible stepping.
        _animStopwatch = System.Diagnostics.Stopwatch.StartNew();
        _isAnimating = true;
        _renderHandler = OnEdgeAnimationFrame;
        System.Windows.Media.CompositionTarget.Rendering += _renderHandler;
    }

    private void OnEdgeAnimationFrame(object? sender, EventArgs e)
    {
        if (_animStopwatch is null) { StopEdgeAnimation(); return; }

        double t = Math.Min(1.0, _animStopwatch.Elapsed.TotalMilliseconds / EdgeAnimMs);
        double eased = t * (2 - t); // ease-out
        Left = _animStartX + (_animTargetX - _animStartX) * eased;

        if (t >= 1.0)
        {
            Left = _animTargetX;
            StopEdgeAnimation();
        }
    }

    private void StopEdgeAnimation()
    {
        if (_renderHandler is not null)
        {
            System.Windows.Media.CompositionTarget.Rendering -= _renderHandler;
            _renderHandler = null;
        }
        _animStopwatch = null;
        _isAnimating = false;
    }

    /// <summary>Keep the saved top-left within the virtual desktop (guards against a
    /// monitor that was unplugged since the last save).</summary>
    private static bool IsOnScreen(double x, double y, double width, double height)
    {
        double minX = SystemParameters.VirtualScreenLeft;
        double minY = SystemParameters.VirtualScreenTop;
        double maxX = minX + SystemParameters.VirtualScreenWidth;
        double maxY = minY + SystemParameters.VirtualScreenHeight;
        return x + width >= minX + 32 && y + height >= minY + 32
            && x <= maxX - 32 && y <= maxY - 32;
    }

    private static double ClampXToVirtualScreen(double x, double width)
    {
        double minX = SystemParameters.VirtualScreenLeft;
        double maxX = minX + SystemParameters.VirtualScreenWidth - width;
        return Math.Max(minX, Math.Min(x, Math.Max(minX, maxX)));
    }

    private static double ClampYToVirtualScreen(double y, double height)
    {
        double minY = SystemParameters.VirtualScreenTop;
        double maxY = minY + SystemParameters.VirtualScreenHeight - height;
        return Math.Max(minY, Math.Min(y, Math.Max(minY, maxY)));
    }

    private static void WriteSettings(Action<JsonObject> mutate)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            JsonObject settings;
            try
            {
                settings = File.Exists(SettingsPath)
                    ? JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject() ?? new JsonObject()
                    : new JsonObject();
            }
            catch { settings = new JsonObject(); }
            mutate(settings);
            File.WriteAllText(SettingsPath, settings.ToJsonString());
        }
        catch { /* best-effort placement cache */ }
    }

    // ── P/Invoke + constants ───────────────────────────────────────────

    private const int WM_NCLBUTTONDOWN = 0xA1;
    private const int HTCAPTION = 2;
    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_TRANSPARENT = 0x00000020L;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_FRAMECHANGED = 0x0020;

    private static nint GetWindowExStyle(nint hWnd) => IntPtr.Size == 8
        ? GetWindowLongPtr64(hWnd, GWL_EXSTYLE)
        : (nint)GetWindowLong32(hWnd, GWL_EXSTYLE);

    private static nint SetWindowExStyle(nint hWnd, nint style) => IntPtr.Size == 8
        ? SetWindowLongPtr64(hWnd, GWL_EXSTYLE, style)
        : (nint)SetWindowLong32(hWnd, GWL_EXSTYLE, style.ToInt32());

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern nint GetWindowLongPtr64(nint hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    private static extern int GetWindowLong32(nint hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern nint SetWindowLongPtr64(nint hWnd, int nIndex, nint dwNewLong);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
    private static extern int SetWindowLong32(nint hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        nint hWnd,
        nint hWndInsertAfter,
        int x,
        int y,
        int cx,
        int cy,
        uint uFlags);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern nint SendMessage(nint hWnd, int msg, nint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
}
