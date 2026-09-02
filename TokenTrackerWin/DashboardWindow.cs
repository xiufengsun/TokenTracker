using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace TokenTrackerWin;

/// <summary>
/// Windows counterpart of <c>DashboardWindowController.swift</c>: a chrome-less
/// window hosting WebView2 pointed at the local dashboard in native-app mode
/// (<c>?app=1</c>), so the layout matches the macOS app (Clawd companion banner,
/// native component treatment).
///
/// This is a <b>WPF</b> window hosting the <b>WPF</b> <see cref="WebView2"/> control.
/// That control renders through a <c>CoreWebView2CompositionController</c>
/// (DirectComposition visual hosting), so its transparent surface genuinely
/// composites with the window's DWM acrylic backdrop — the page's transparent
/// regions (sidebar + title strip + the empty dark gaps) read as frosted glass,
/// the Windows analogue of the macOS NSVisualEffectView. The earlier windowed
/// WinForms WebView2 control could not do this: a child HWND can't alpha-blend
/// with the backdrop, so transparent pixels rendered black.
///
/// The min/max/close buttons + drag are injected into the web content (there is no
/// native caption bar — see "Window controls" below). <see cref="WindowChrome"/>
/// keeps the window resizable + Aero-snappable despite having no visible caption.
///
/// Closing releases WebView2 so the hidden dashboard does not keep Chromium's
/// renderer and graphics surfaces resident. Persistent WebView2 storage keeps the
/// login across recreation; an active OAuth PKCE round trip is retained temporarily.
/// The app exits via the tray "Quit" → <see cref="Shutdown"/>.
/// </summary>
internal sealed class DashboardWindow : Window
{
    // WebView2CompositionControl (NOT the plain WebView2): it hosts via visual /
    // DirectComposition (CoreWebView2CompositionController) instead of a windowed
    // HwndHost, which is the ONLY WPF control that renders a genuinely transparent
    // surface. The plain WebView2 control's transparent background falls back to an
    // opaque dark theme colour (windowed-hosting limitation), which is why the page's
    // empty regions rendered black. Drop-in API-compatible replacement.
    // AllowExternalDrop must be off: windowless (DirectComposition) hosting does not
    // support external drag-drop and throws on initialization otherwise.
    private readonly WebView2CompositionControl _webView = new() { AllowExternalDrop = false };
    private readonly ServerManager _server;
    private bool _coreReady;
    private bool _exiting;
    private bool _oauthInFlight;
    private CancellationTokenSource? _oauthTimeout;
    private nint _hwnd;
    private string _pendingPathAndQuery = "/?app=1";

    /// <summary>Raised (on the UI thread) when the dashboard's currency/rate localStorage changes.</summary>
    public event Action? CurrencyChanged;

    /// <summary>Raised (on the UI thread) when the dashboard's language localStorage changes.</summary>
    public event Action? LocaleChanged;

    /// <summary>Raised (on the UI thread) when the dashboard's theme localStorage changes.</summary>
    public event Action? ThemeChanged;

    public event Action? PetSettingsRequested;
    public event Action<string, string?>? PetSettingChanged;
    /// <summary>Raised when the dashboard asks for the native settings snapshot.</summary>
    public event Action? NativeSettingsRequested;
    /// <summary>Raised when the dashboard changes a native setting.</summary>
    public event Action<string, object?>? NativeSettingChanged;
    /// <summary>Raised when the dashboard invokes a native action.</summary>
    public event Action<string>? NativeActionRequested;
    public event Action<string, string>? NotificationRequested;
    public event Action<DashboardWindow>? ReleasedForIdle;

    public DashboardWindow(ServerManager server)
    {
        _server = server;

        Title = Constants.AppDisplayName;
        // Open large (like the macOS window) so the dashboard stays above its
        // lg/1024px responsive breakpoint and shows the full sidebar instead of
        // collapsing to the narrow hamburger layout.
        var wa = SystemParameters.WorkArea;
        Width = Math.Min(1760, wa.Width * 0.92);
        Height = Math.Min(1060, wa.Height * 0.92);
        MinWidth = 900;
        MinHeight = 640;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        WindowStyle = WindowStyle.None;          // no OS title bar
        ResizeMode = ResizeMode.CanResize;
        // Transparent window background so the DWM acrylic backdrop (set in
        // OnSourceInitialized) shows through the page's now-transparent regions.
        Background = System.Windows.Media.Brushes.Transparent;
        ShowInTaskbar = true;
        try { Icon = LoadWindowIcon(); } catch { /* fall back to default */ }

        // Borderless but resizable + Aero-snappable: WindowChrome keeps the resize
        // borders + snap while removing the OS caption (CaptionHeight = 0, because the
        // title strip is injected into the web content). Rounded corners match the
        // macOS window chrome.
        WindowChrome.SetWindowChrome(this, new WindowChrome
        {
            CaptionHeight = 0,
            ResizeBorderThickness = new Thickness(6),
            CornerRadius = new CornerRadius(8),
            // -1 = "sheet of glass": the whole client area is treated as glass frame, so
            // the DWM system backdrop (Mica/Acrylic) renders across the entire window.
            // With 0 the client area is opaque and the backdrop never shows (the
            // transparent page regions then fall back to black).
            GlassFrameThickness = new Thickness(-1),
            UseAeroCaptionButtons = false,
        });

        // NOTE: do NOT set DefaultBackgroundColor = Transparent via the API — on the WPF
        // control that maps to the dark ApplicationPageBackgroundThemeBrush instead of
        // real transparency. Transparency is requested via the WEBVIEW2_DEFAULT_
        // BACKGROUND_COLOR=0 env var in InitializeWebViewAsync instead.
        Content = _webView;

        Loaded += async (_, _) => await InitializeWebViewAsync();
        StateChanged += (_, _) =>
        {
            SyncMaxGlyph();
            // Minimising this window (WindowStyle.None + WindowChrome
            // GlassFrameThickness=-1 "sheet of glass" + DwmExtendFrameIntoClientArea(-1)
            // + Acrylic, hosting a WebView2CompositionControl / DirectComposition visual)
            // leaves a transparent, hit-testable "ghost" at the window's pre-minimise
            // rectangle: the DComp visual isn't torn down on minimise, so it keeps
            // presenting / capturing mouse input over the desktop (you can see the desktop
            // but can't click anything inside the old window rect; desktop icons stop
            // highlighting). Collapsing the WebView2CompositionControl removes its DComp
            // visual from the window's composition tree, so the ghost stops presenting /
            // hit-testing, while the HWND itself truly minimises — staying taskbar- and
            // Win+D-restorable. Restored to Visible on Normal. This covers every minimise
            // path uniformly (the minimise button, taskbar click, Win+D "show desktop",
            // right-click -> Minimize, programmatic SW_MINIMIZE) with no behavioural
            // change (minimise still minimises-to-taskbar) and without Hide(), which broke
            // Win+D restore (the HWND left DWM's minimised-windows list) and tray restore
            // (WindowState stayed Minimized, so ShowDashboard re-fired this handler).
            _webView.Visibility = (WindowState == WindowState.Minimized)
                ? Visibility.Collapsed
                : Visibility.Visible;
        };
        KeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Escape) CloseOrHideForOAuth(); };
        _server.StatusChanged += OnServerStatusChanged;
    }

    private static System.Windows.Media.ImageSource? LoadWindowIcon()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "assets", "trayicon.ico");
        if (!File.Exists(path)) return null;
        return System.Windows.Media.Imaging.BitmapFrame.Create(
            new Uri(path),
            System.Windows.Media.Imaging.BitmapCreateOptions.None,
            System.Windows.Media.Imaging.BitmapCacheOption.OnLoad);
    }

    // ── Window controls (rendered inside the WebView) ──────────────────
    //
    // There is no native caption bar. The title strip + min/max/close buttons are
    // injected into the transparent web content (see ApplyNativeChromeAsync) and post
    // messages back here for drag / minimise / maximise / close (handled in
    // WebMessageReceived). This keeps the whole top strip glass, like the macOS
    // window's transparent title bar.

    /// <summary>Keep the injected maximise/restore glyph in sync with the window state.</summary>
    private void SyncMaxGlyph()
    {
        if (!_coreReady) return;
        var maxed = WindowState == WindowState.Maximized ? "true" : "false";
        try { _ = _webView.CoreWebView2.ExecuteScriptAsync($"window.__ttSetMax&&window.__ttSetMax({maxed})"); }
        catch { /* page not ready */ }
    }

    private void ToggleMaximize() =>
        WindowState = WindowState == WindowState.Maximized
            ? WindowState.Normal
            : WindowState.Maximized;

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        _hwnd = new WindowInteropHelper(this).Handle;

        // Dark window chrome so any DWM-drawn pixels stay dark (the app defaults to a
        // dark theme; a user's Settings choice still recolours the page contents).
        int dark = 1;
        DwmSetWindowAttribute(_hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));

        // Win11 rounded corners, matching the macOS window's rounded chrome.
        int round = DWMWCP_ROUND;
        DwmSetWindowAttribute(_hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int));

        // Extend the DWM frame across the whole client (sheet of glass) so the system
        // backdrop fills the entire window, not just the caption band.
        var margins = new MARGINS { Left = -1, Right = -1, Top = -1, Bottom = -1 };
        DwmExtendFrameIntoClientArea(_hwnd, ref margins);

        // Win11 system backdrop: Acrylic (semi-transparent frosted glass) — the
        // supported replacement for the legacy SetWindowCompositionAttribute accent
        // acrylic, which renders flat/near-black on current Win11 builds. Combined
        // with the transparent WPF background + the transparent (composition-hosted)
        // WebView2, the page's transparent regions now read as real frosted glass.
        ApplyBackdrop(DWMSBT_TRANSIENTWINDOW);
    }

    /// <summary>Set the Win11 DWM system backdrop type for this window.</summary>
    private void ApplyBackdrop(int type)
    {
        if (_hwnd == 0) return;
        DwmSetWindowAttribute(_hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ref type, sizeof(int));
    }

    // ── WebView2 ───────────────────────────────────────────────────────

    private async Task InitializeWebViewAsync()
    {
        if (_coreReady) return;

        // WebView2 needs a writable user-data folder; the exe dir may be read-only
        // (Program Files). Persist under LocalAppData so login/cookies survive restarts.
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "TokenTracker", "WebView2");
        Directory.CreateDirectory(userDataFolder);

        // Make the WebView2 composition surface itself transparent. Must be set before
        // the browser process is created. "00FFFFFF" = alpha 0 (transparent); only
        // alpha 0 or 255 are supported.
        Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0");

        // Disable Chromium background/occlusion throttling. When the OAuth callback
        // deep-links back, our app is still in the background (the system browser has
        // focus), so the dashboard WebView is occluded. WebView2 would otherwise
        // suspend/throttle its JS — stalling the InsForge SDK's code-exchange and the
        // SPA's redirect to /dashboard, so the sign-in never completes until (and
        // unless) the window is brought forward. These flags keep the callback page's
        // timers + network running while occluded, so login finishes regardless of focus.
        var options = new CoreWebView2EnvironmentOptions
        {
            AdditionalBrowserArguments =
                "--disable-background-timer-throttling " +
                "--disable-renderer-backgrounding " +
                "--disable-backgrounding-occluded-windows",
        };
        var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder, options);
        await _webView.EnsureCoreWebView2Async(env);
        _coreReady = true;

        // Now that the controller exists, explicitly set a fully transparent default
        // background. On the composition control this genuinely makes the surface
        // transparent (host content shows through the page's transparent regions);
        // only alpha 0 or 255 are valid.
        _webView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0, 0, 0, 0);

        var core = _webView.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;

        // Open target=_blank / external links in the system browser, not a popup WebView.
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenInBrowser(e.Uri);
        };

        // Top-level navigations away from the local server go to the system browser.
        core.NavigationStarting += (_, e) =>
        {
            Log($"nav starting uri={e.Uri}");
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)
                && uri.Scheme is "http" or "https"
                && uri.Host is not ("127.0.0.1" or "localhost"))
            {
                e.Cancel = true;
                OpenInBrowser(e.Uri);
            }
        };

        core.NavigationCompleted += async (_, _) =>
        {
            try { Log($"nav completed uri={_webView.CoreWebView2.Source}"); } catch { }
            if (_oauthInFlight
                && Uri.TryCreate(_webView.CoreWebView2.Source, UriKind.Absolute, out var completedUri)
                && completedUri.AbsolutePath is "/" or "/dashboard")
            {
                CompleteNativeOAuth();
            }
            await ApplyNativeChromeAsync();
        };

        // SPA route changes (history.pushState) don't raise NavigationCompleted; this
        // does, so we can observe the callback page's client-side redirect to /dashboard.
        core.HistoryChanged += (_, _) =>
        {
            try { Log($"history changed uri={_webView.CoreWebView2.Source}"); } catch { }
        };

        // The injected script posts setting changes, and the injected title bar
        // (ApplyNativeChromeAsync) posts "win:*" for the window controls + drag.
        core.WebMessageReceived += (_, e) =>
        {
            string msg;
            try { msg = e.TryGetWebMessageAsString(); }
            catch { return; } // non-string message

            // OAuth: the injected nativeOAuth shim posts {type:"oauth",url} with the
            // provider authorize URL. Open it in the system browser (where the user has
            // saved Google/GitHub sessions, and where Google permits OAuth — embedded
            // webviews are blocked). The browser redirects back to the whitelisted
            // 127.0.0.1:17680/auth/callback, whose page deep-links the code to us via the
            // tokentracker:// scheme. Mirrors the macOS nativeOAuth handler.
            if (msg.Length > 0 && msg[0] == '{')
            {
                try
                {
                    using var doc = JsonDocument.Parse(msg);
                    if (!doc.RootElement.TryGetProperty("type", out var t)) return;
                    if (t.GetString() == "oauth"
                        && doc.RootElement.TryGetProperty("url", out var u) && u.GetString() is { } url)
                    {
                        Log($"oauth open url={url}");
                        BeginNativeOAuth();
                        OpenInBrowser(url);
                    }
                    else if (t.GetString() == "authCompleted")
                    {
                        CompleteNativeOAuth();
                    }
                    else if (t.GetString() == "getSettings")
                    {
                        NativeSettingsRequested?.Invoke();
                    }
                    else if (t.GetString() == "setSetting"
                             && doc.RootElement.TryGetProperty("key", out var settingKey)
                             && doc.RootElement.TryGetProperty("value", out var settingValue))
                    {
                        if (settingKey.GetString() is { } key)
                            NativeSettingChanged?.Invoke(key, JsonValueToObject(settingValue));
                    }
                    else if (t.GetString() == "action"
                             && doc.RootElement.TryGetProperty("name", out var actionName)
                             && actionName.GetString() is { } name)
                    {
                        NativeActionRequested?.Invoke(name);
                    }
                    else if (t.GetString() == "nativeSetting"
                             && doc.RootElement.TryGetProperty("key", out var k)
                             && doc.RootElement.TryGetProperty("value", out var v))
                    {
                        var key = k.GetString();
                        var value = v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                        if (key == NativeLocalization.PreferenceKey)
                        {
                            NativeLocalization.StorePreference(value);
                            LocaleChanged?.Invoke();
                        }
                        else if (key == NativeTheme.PreferenceKey)
                        {
                            NativeTheme.StorePreference(value);
                            ThemeChanged?.Invoke();
                        }
                        else if (key is "tokentracker-currency" or "tokentracker-exchange-rates")
                        {
                            CurrencyChanged?.Invoke();
                        }
                    }
                    else if (t.GetString() == "getPetSettings")
                    {
                        PetSettingsRequested?.Invoke();
                    }
                    else if (t.GetString() == "setPetSetting"
                             && doc.RootElement.TryGetProperty("key", out var petKey)
                             && doc.RootElement.TryGetProperty("value", out var petValue))
                    {
                        var value = petValue.ValueKind switch
                        {
                            JsonValueKind.String => petValue.GetString(),
                            JsonValueKind.True => "true",
                            JsonValueKind.False => "false",
                            _ => petValue.GetRawText(),
                        };
                        if (petKey.GetString() is { } key) PetSettingChanged?.Invoke(key, value);
                    }
                    else if (t.GetString() == "notify"
                             && doc.RootElement.TryGetProperty("title", out var notifyTitle)
                             && doc.RootElement.TryGetProperty("body", out var notifyBody))
                    {
                        var title = notifyTitle.GetString();
                        var body = notifyBody.GetString();
                        if (!string.IsNullOrWhiteSpace(title) && !string.IsNullOrWhiteSpace(body))
                            NotificationRequested?.Invoke(title[..Math.Min(title.Length, 120)], body[..Math.Min(body.Length, 500)]);
                    }
                }
                catch { /* not a JSON message we handle */ }
                return;
            }

            switch (msg)
            {
                case "currency": CurrencyChanged?.Invoke(); break;
                case "locale": LocaleChanged?.Invoke(); break;
                case "theme": ThemeChanged?.Invoke(); break;
                case "win:min": WindowState = WindowState.Minimized; break;
                case "win:max": ToggleMaximize(); break;
                case "win:close": CloseOrHideForOAuth(); break;
                case "win:drag":
                    // Hand the drag off to the OS so Aero-snap / move works natively.
                    ReleaseCapture();
                    SendMessage(_hwnd, WM_NCLBUTTONDOWN, (nint)HTCAPTION, nint.Zero);
                    break;
            }
        };

        // Before first paint (document-start, ahead of the page's own scripts):
        //  1. Default to the dark theme so the window opens dark like the macOS app; a
        //     user's choice in Settings still wins (we only set it when unset).
        //  2. Mark native-app on <html> so the dashboard's transparent-background
        //     rules apply — letting the acrylic backdrop show through.
        //  3. Wrap localStorage.setItem to notify native when tray-facing settings change.
        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            "try{if(!localStorage.getItem('tokentracker-theme')){" +
            "localStorage.setItem('tokentracker-theme','dark');" +
            "document.documentElement.classList.add('dark');}" +
            "document.documentElement.classList.add('native-app');" +
            "document.documentElement.classList.add('native-windows-app');" +
            "var s=document.createElement('style');" +
            "s.textContent='html,html.dark,body,#root{background:transparent!important}';" +
            "(document.head||document.documentElement).appendChild(s);" +
            "var _set=localStorage.setItem.bind(localStorage);" +
            "localStorage.setItem=function(k,v){_set(k,v);" +
            "if(k==='tokentracker-currency'||k==='tokentracker-exchange-rates'){" +
            "try{window.chrome.webview.postMessage('currency');}catch(e){}" +
            "try{window.chrome.webview.postMessage(JSON.stringify({type:'nativeSetting',key:k,value:v}));}catch(e){}}" +
            "if(k==='tokentracker-locale'){" +
            "try{window.chrome.webview.postMessage('locale');}catch(e){}" +
            "try{window.chrome.webview.postMessage(JSON.stringify({type:'nativeSetting',key:k,value:v}));}catch(e){}}" +
            "if(k==='tokentracker-theme'){" +
            "try{window.chrome.webview.postMessage('theme');}catch(e){}" +
            "try{window.chrome.webview.postMessage(JSON.stringify({type:'nativeSetting',key:k,value:v}));}catch(e){}}};" +
            // nativeOAuth shim: the dashboard's OAuth code already has a native branch
            // gated on window.webkit.messageHandlers.nativeOAuth (the macOS bridge).
            // Provide the same shape here so that branch fires on Windows too — it posts
            // the provider authorize URL, which we forward to the system browser (see
            // WebMessageReceived). Needs no dashboard JS changes for the OAuth start.
            "try{window.webkit=window.webkit||{};" +
            "window.webkit.messageHandlers=window.webkit.messageHandlers||{};" +
            "window.webkit.messageHandlers.nativeOAuth={postMessage:function(u){" +
            "try{window.chrome.webview.postMessage(JSON.stringify({type:'oauth',url:u}));}catch(e){}}};" +
            "}catch(e){}" +
            "}catch(e){}");

        // ?app=1 → dashboard renders in native-app layout (Clawd companion, native
        // component treatment, transparent root + 28px drag strip), matching macOS.
        NavigateWhenServerReady("/?app=1");
    }

    public void PushPetSettings(bool visible, string size, string character, string botColor)
    {
        if (!_coreReady) return;
        var json = JsonSerializer.Serialize(new { visible, size, character, botColor });
        try
        {
            _ = _webView.CoreWebView2.ExecuteScriptAsync(
                $"window.dispatchEvent(new CustomEvent('native:petSettings', {{detail:{json}}}));");
        }
        catch { /* page is navigating */ }
    }

    private void OnServerStatusChanged(ServerManager.ServerStatus status)
    {
        if (status != ServerManager.ServerStatus.Running) return;
        try
        {
            Dispatcher.BeginInvoke(new Action(() => NavigateWhenServerReady(_pendingPathAndQuery)));
        }
        catch { /* window is closing */ }
    }

    private void NavigateWhenServerReady(string pathAndQuery)
    {
        _pendingPathAndQuery = pathAndQuery;
        if (!_coreReady || _server.Status != ServerManager.ServerStatus.Running) return;
        _webView.CoreWebView2.Navigate(_server.BaseUrl + pathAndQuery);
    }

    /// <summary>
    /// Mirror the CSS the macOS app injects (hide scrollbars, disable text
    /// selection), inject the custom window controls + drag strip, then read the
    /// resolved currency so the tray can render the cost.
    ///
    /// The glass tints here are deliberately low-alpha so the real OS acrylic
    /// backdrop shows through (this is the "纯黑 → 半透明" effect): the empty dark
    /// gaps become translucent frosted glass while the solid cards stay solid.
    /// </summary>
    private async Task ApplyNativeChromeAsync()
    {
        if (!_coreReady) return;
        // The dashboard's committed styles.css paints body.tt-native-glass-shell AND the
        // AppLayout root (.fixed.inset-0) with an opaque rgba(32,32,32,0.72) — that is
        // what covered the transparent surface. We override with selectors at least as
        // specific (html.native-windows-app …) and force the shells fully transparent.
        // The frosted tint lives only on the body's ::before overlay at low alpha, so
        // the window's DWM acrylic shows through. Solid cards keep their own bg.
        const string css = """
            ::-webkit-scrollbar{display:none!important}
            *{-webkit-user-select:none;user-select:none}
            input,textarea{-webkit-user-select:text;user-select:text}

            html.native-windows-app,
            html.native-windows-app.dark,
            html.native-windows-app body,
            html.native-windows-app body.tt-native-glass-shell,
            html.native-windows-app #root,
            html.native-windows-app #root>.fixed.inset-0{
              background:transparent!important;
              background-color:transparent!important;
            }
            html.native-windows-app body.tt-native-glass-shell{isolation:isolate}
            /* Frosted tint overlay. MUST use >=3 classes (html.native-windows-app.dark
               body.tt-native-glass-shell) to beat the committed styles.css rule
               `html.native-windows-app.dark .tt-native-glass-shell::before` (3 classes);
               the earlier 2-class rule lost the specificity war so neither the darker
               tint nor the rounding ever applied. position:fixed + rounded corners so
               the tint follows the window's DWM rounded edge (no hard top-left angle). */
            html.native-windows-app.dark body.tt-native-glass-shell::before,
            html.native-windows-app:not(.dark) body.tt-native-glass-shell::before{
              content:"";
              position:fixed!important;
              inset:0!important;
              z-index:0!important;
              pointer-events:none!important;
              border-radius:10px!important;
              /* Frosted blur restored — this is the glass/translucent texture. */
              backdrop-filter:blur(40px) saturate(135%)!important;
              -webkit-backdrop-filter:blur(40px) saturate(135%)!important;
            }
            html.native-windows-app.dark body.tt-native-glass-shell::before{
              background:
                linear-gradient(180deg,rgba(255,255,255,.04),transparent 24%),
                rgba(16,16,16,.72)!important;
            }
            html.native-windows-app:not(.dark) body.tt-native-glass-shell::before{
              background:
                linear-gradient(180deg,rgba(255,255,255,.5),rgba(255,255,255,.22) 24%),
                rgba(236,236,238,.55)!important;
            }
            /* Keep a top gap above the main card so the top glass strip + the left
               sidebar glass merge into one continuous L-shaped frosted frame, with the
               solid card sitting as an island inside it (the macOS look). The dashboard's
               own p-2 (8px) top padding provides this gap; bump to ~12px so it matches
               the right/bottom gutter (lg:pr-3/lg:pb-3) for a uniform frame all around. */
            html.native-windows-app #root .flex-1.min-w-0.min-h-0{
              padding-top:12px!important;
            }
            /* Lift the app content above the fixed ::before glass overlay. Scoped to
               #root (NOT >*): body also hosts React portals (e.g. the heatmap hover
               tooltip) whose class-based position:fixed a >* rule would override,
               dropping them into normal flow at the page bottom (#252). */
            html.native-windows-app body.tt-native-glass-shell>#root{position:relative;z-index:1}
            /* Sidebar must have NOTHING of its own — no fill, no border, no shadow, and
               crucially NO backdrop-filter. The committed styles.css gives the aside its
               own blur(30px), which double-blurs the sidebar region vs the top strip and
               creates the visible seam. Killing it makes the sidebar show the single
               body::before glass exactly like the top strip → one continuous surface. */
            html.native-windows-app .tt-native-glass-shell aside[data-native-sidebar]{
              background:transparent!important;
              border-right:none!important;
              box-shadow:none!important;
              backdrop-filter:none!important;
              -webkit-backdrop-filter:none!important;
            }
            /* Main content card: cohesive rounded panel like macOS — keep its solid bg
               (from the dashboard's own classes), just guarantee rounding on all four
               corners + a subtle glass-friendly border. This is what makes the right
               side read as ONE unit with proper bottom rounding. */
            html.native-windows-app .tt-native-main-card{
              border-radius:12px!important;
              overflow:hidden!important;
            }
            html.native-windows-app.dark .tt-native-main-card{
              border:1px solid rgba(255,255,255,.07)!important;
            }
            html.native-windows-app:not(.dark) .tt-native-main-card{
              border:1px solid rgba(0,0,0,.08)!important;
            }
            #tt-titlebar{background:transparent!important}
            """;
        var js =
            "document.documentElement.classList.add('native-app','native-windows-app');" +
            "document.body&&document.body.classList.add('tt-native-glass-shell');" +
            "var s=document.getElementById('tt-native-win-css')||document.createElement('style');" +
            "s.id='tt-native-win-css';s.textContent=" + JsonSerializer.Serialize(css) + ";" +
            "(document.head||document.documentElement).appendChild(s);" +
            // Inline !important on the actual shell elements — beats any stylesheet rule
            // regardless of specificity. Covers html/body/#root and the AppLayout root
            // (#root's full-viewport .fixed.inset-0 child), which both had the opaque bg.
            "['documentElement','body'].forEach(function(k){var e=document[k];" +
            "if(e)e.style.setProperty('background','transparent','important');});" +
            "var rt=document.getElementById('root');" +
            "if(rt){rt.style.setProperty('background','transparent','important');" +
            "rt.querySelectorAll(':scope>.fixed.inset-0').forEach(function(e){" +
            "e.style.setProperty('background','transparent','important');});}";
        try
        {
            await _webView.CoreWebView2.ExecuteScriptAsync(js);
            await _webView.CoreWebView2.ExecuteScriptAsync(TitleBarScript);
            // Belt-and-suspenders: guarantee the nativeOAuth shim exists *after* the page
            // has loaded. The document-created injection can lose a race against the first
            // navigation, leaving the shim absent — then the dashboard's OAuth code takes
            // its web branch (redirect → "/", no callback page) and login never completes.
            // Re-injecting here runs on every NavigationCompleted, so the shim is reliably
            // present by the time the user clicks a provider button. Idempotent; logs
            // whether it was already there for diagnostics.
            var hadShim = await _webView.CoreWebView2.ExecuteScriptAsync(
                "(function(){var had=!!(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.nativeOAuth);" +
                "window.webkit=window.webkit||{};window.webkit.messageHandlers=window.webkit.messageHandlers||{};" +
                "if(!window.webkit.messageHandlers.nativeOAuth){window.webkit.messageHandlers.nativeOAuth={postMessage:function(u){" +
                "try{window.chrome.webview.postMessage(JSON.stringify({type:'oauth',url:u}));}catch(e){}}};}" +
                "return had;})()");
            Log($"nativeOAuth shim present-before-reinject={hadShim}");
            // Sync the maximise/restore glyph to the current state.
            var maxed = WindowState == WindowState.Maximized ? "true" : "false";
            await _webView.CoreWebView2.ExecuteScriptAsync($"window.__ttSetMax&&window.__ttSetMax({maxed})");
        }
        catch { /* page navigated away mid-script */ }

        // The page is loaded → the currency localStorage is now readable; nudge the
        // tray to render the cost in the user's chosen currency immediately.
        CurrencyChanged?.Invoke();
        LocaleChanged?.Invoke();
        ThemeChanged?.Invoke();
    }

    /// <summary>
    /// Injected window controls: a transparent full-width strip (so the page's own
    /// reserved 28px drag area stays glass) with min/max/close buttons at the right.
    /// The bar is click-through (pointer-events:none) except the buttons; dragging is
    /// handled by a document mousedown in the top 28px. Buttons + drag post "win:*"
    /// messages back to the host (see WebMessageReceived). Idempotent across SPA
    /// navigations via the #tt-winbtns guard.
    /// </summary>
    private const string TitleBarScript =
        "(function(){if(document.getElementById('tt-winbtns'))return;" +
        "var ff=\"'Segoe Fluent Icons','Segoe MDL2 Assets'\";" +
        "var bar=document.createElement('div');bar.id='tt-titlebar';" +
        "bar.style.cssText='position:fixed;top:0;left:0;right:0;height:28px;" +
        "z-index:2147483647;pointer-events:none;display:flex;justify-content:flex-end;';" +
        "var g=document.createElement('div');g.id='tt-winbtns';" +
        "g.style.cssText='pointer-events:auto;display:flex;height:28px;';" +
        "function mk(ch,kind,hov){var b=document.createElement('div');" +
        "b.style.cssText='width:44px;height:28px;display:flex;align-items:center;" +
        "justify-content:center;font-family:'+ff+';font-size:10px;color:#c8c8c8;" +
        "cursor:default;transition:background .1s;';b.textContent=ch;" +
        "b.addEventListener('mouseenter',function(){b.style.background=hov;b.style.color='#fff';});" +
        "b.addEventListener('mouseleave',function(){b.style.background='transparent';b.style.color='#c8c8c8';});" +
        "b.addEventListener('click',function(e){e.stopPropagation();" +
        "try{window.chrome.webview.postMessage('win:'+kind);}catch(_){}});return b;}" +
        "var mn=mk('\\uE921','min','rgba(255,255,255,0.12)');" +
        "var mx=mk('\\uE922','max','rgba(255,255,255,0.12)');" +
        "var cl=mk('\\uE8BB','close','#c42b1c');" +
        "window.__ttSetMax=function(m){mx.textContent=m?'\\uE923':'\\uE922';};" +
        "g.appendChild(mn);g.appendChild(mx);g.appendChild(cl);bar.appendChild(g);" +
        "(document.body||document.documentElement).appendChild(bar);" +
        "document.addEventListener('mousedown',function(e){" +
        "if(e.button===0&&e.clientY<28&&!(e.target.closest&&e.target.closest('#tt-winbtns'))){" +
        "try{window.chrome.webview.postMessage('win:drag');}catch(_){}}}, true);" +
        "document.addEventListener('dblclick',function(e){" +
        "if(e.clientY<28&&!(e.target.closest&&e.target.closest('#tt-winbtns'))){" +
        "try{window.chrome.webview.postMessage('win:max');}catch(_){}}}, true);" +
        "})();";

    // ── Public API ─────────────────────────────────────────────────────

    private void BeginNativeOAuth()
    {
        _oauthInFlight = true;
        _oauthTimeout?.Cancel();
        _oauthTimeout?.Dispose();
        _oauthTimeout = new CancellationTokenSource();
        _ = WaitForNativeOAuthTimeoutAsync(_oauthTimeout.Token);
    }

    private async Task WaitForNativeOAuthTimeoutAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(10), cancellationToken);
            await Dispatcher.InvokeAsync(ExpireNativeOAuth);
        }
        catch (OperationCanceledException)
        {
            // A completed/restarted flow or app shutdown owns the next transition.
        }
    }

    /// <summary>Push the native settings snapshot to the dashboard WebView.</summary>
    public void PushNativeSettings(object settings)
    {
        if (!_coreReady) return;
        var json = JsonSerializer.Serialize(settings);
        try
        {
            _ = _webView.CoreWebView2.ExecuteScriptAsync(
                $"window.dispatchEvent(new CustomEvent('native:settings', {{detail:{json}}}));");
        }
        catch { /* page is navigating */ }
    }

    private static object? JsonValueToObject(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Number when value.TryGetInt64(out var integer) => integer,
            JsonValueKind.Number when value.TryGetDouble(out var number) => number,
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Null or JsonValueKind.Undefined => null,
            _ => value.GetRawText(),
        };
    }

    private void CompleteNativeOAuth()
    {
        if (!_oauthInFlight) return;
        _oauthInFlight = false;
        _oauthTimeout?.Cancel();
        _oauthTimeout?.Dispose();
        _oauthTimeout = null;
        if (!IsVisible) CloseOrHideForOAuth();
    }

    private void ExpireNativeOAuth()
    {
        CompleteNativeOAuth();
    }

    private void CloseOrHideForOAuth()
    {
        if (_oauthInFlight)
        {
            Hide();
            return;
        }
        Close();
    }

    /// <summary>Show the dashboard, bringing an already-open window to the front.</summary>
    public void ShowDashboard()
    {
        if (!IsVisible) Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
        // Nudge to the foreground without leaving the window pinned topmost.
        Topmost = true;
        Topmost = false;
    }

    /// <summary>Toggle visibility — used by the tray left-click (popover-like).</summary>
    public void ToggleDashboard()
    {
        if (IsVisible && WindowState != WindowState.Minimized) CloseOrHideForOAuth();
        else ShowDashboard();
    }

    /// <summary>Navigate to the dashboard Settings page, mirroring macOS `showSettings()`.</summary>
    public void ShowSettings()
    {
        ShowDashboard();
        NavigateWhenServerReady("/settings?app=1");
    }

    /// <summary>
    /// Finish an OAuth sign-in: load the callback page in this WebView so the InsForge
    /// SDK exchanges the code using the PKCE verifier already in this WebView's storage
    /// (the same context that started the flow), then hard-reload the dashboard root so
    /// the freshly-relayed session is picked up. Mirrors macOS
    /// <c>handleAuthCallback</c> + <c>handleAuthDone</c>.
    /// </summary>
    public void HandleAuthCallback(string code)
    {
        Log($"HandleAuthCallback code.len={code.Length}");
        ShowDashboard();
        BrowserTabCloser.CloseAuthCallbackTab(_server.BaseUrl, _hwnd);
        var encoded = Uri.EscapeDataString(code);
        NavigateWhenServerReady($"/auth/callback?insforge_code={encoded}&app=1");

        // The callback page exchanges the code → the local server captures the
        // insforge_refresh_token cookie (the relay). In-page the React auth context
        // does NOT reliably flip to signed-in here on Windows (confirmed: the UI stays
        // logged-out, yet a *restart* shows signed-in — proving the session is fully
        // persisted server-side). So once the exchange has had time to land, reload
        // /?app=1: a fresh load reads the relayed session and renders signed-in, exactly
        // like the working restart. Mirrors macOS handleAuthDone()'s reload.
        _ = Dispatcher.BeginInvoke(async () =>
        {
            await Task.Delay(2000);
            try
            {
                var path = await _webView.CoreWebView2.ExecuteScriptAsync("location.pathname");
                Log($"post-callback path={path} → reloading /?app=1");
            }
            catch { /* window closed / page navigating */ }
            NavigateWhenServerReady("/?app=1");
        });
    }

    /// <summary>Diagnostics → %LOCALAPPDATA%\TokenTracker\windows-host.log (shared with ServerManager).</summary>
    private static void Log(string message) => Diag.Log("dashboard", message);

    /// <summary>
    /// Read the user's currency choice + USD→currency rate from the dashboard's
    /// localStorage. Returns ("$", 1) until the WebView is ready or on any failure.
    /// </summary>
    public async Task<(string Symbol, decimal Rate)> ReadCurrencyAsync()
    {
        if (!_coreReady) return ("$", 1m);
        try
        {
            var raw = await _webView.CoreWebView2.ExecuteScriptAsync(
                "(function(){return {c:localStorage.getItem('tokentracker-currency')," +
                "r:localStorage.getItem('tokentracker-exchange-rates')};})()");
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            var code = root.TryGetProperty("c", out var cEl) ? cEl.GetString() : null;
            if (string.IsNullOrWhiteSpace(code)) return ("$", 1m);
            code = code.ToUpperInvariant();
            var symbol = Currency.Symbol(code);
            if (code == "USD") return (symbol, 1m);

            decimal rate = Currency.DefaultRate(code);
            var ratesStr = root.TryGetProperty("r", out var rEl) ? rEl.GetString() : null;
            if (!string.IsNullOrEmpty(ratesStr))
            {
                using var rdoc = JsonDocument.Parse(ratesStr);
                if (rdoc.RootElement.TryGetProperty(code, out var rv)
                    && rv.ValueKind == JsonValueKind.Number
                    && rv.TryGetDecimal(out var rr) && rr > 0)
                    rate = rr;
            }
            return (symbol, rate);
        }
        catch { return ("$", 1m); }
    }

    /// <summary>
    /// Read the user's language preference from dashboard localStorage. Returns
    /// "system" until the WebView is ready or on any failure.
    /// </summary>
    public async Task<string> ReadLocalePreferenceAsync()
    {
        if (!_coreReady) return NativeLocalization.SystemPreference;
        try
        {
            var raw = await _webView.CoreWebView2.ExecuteScriptAsync(
                "(function(){return localStorage.getItem('tokentracker-locale')||'system';})()");
            var value = JsonSerializer.Deserialize<string>(raw);
            var normalized = NativeLocalization.NormalizePreference(value);
            NativeLocalization.StorePreference(normalized);
            return normalized;
        }
        catch
        {
            return NativeLocalization.SystemPreference;
        }
    }

    /// <summary>
    /// Read the user's theme preference from dashboard localStorage. Returns "dark"
    /// until the WebView is ready or on any failure.
    /// </summary>
    public async Task<string> ReadThemePreferenceAsync()
    {
        if (!_coreReady) return NativeTheme.DarkPreference;
        try
        {
            var raw = await _webView.CoreWebView2.ExecuteScriptAsync(
                "(function(){return localStorage.getItem('tokentracker-theme')||'dark';})()");
            var value = JsonSerializer.Deserialize<string>(raw);
            var normalized = NativeTheme.NormalizePreference(value);
            NativeTheme.StorePreference(normalized);
            return normalized;
        }
        catch
        {
            return NativeTheme.DarkPreference;
        }
    }

    /// <summary>Really close the window + tear down (called from the tray "Quit").</summary>
    public void Shutdown()
    {
        _exiting = true;
        Close();
    }

    private static void OpenInBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { /* no default browser / malformed url */ }
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        // Preserve sessionStorage only while OAuth needs its PKCE verifier. In every
        // normal close path, allow WPF to close so OnClosed can dispose WebView2.
        if (!_exiting && _oauthInFlight)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        _server.StatusChanged -= OnServerStatusChanged;
        base.OnClosing(e);
    }

    protected override void OnClosed(EventArgs e)
    {
        _oauthTimeout?.Cancel();
        _oauthTimeout?.Dispose();
        _oauthTimeout = null;
        _coreReady = false;
        Content = null;
        _webView.Dispose();
        base.OnClosed(e);
        if (!_exiting) ReleasedForIdle?.Invoke(this);
    }

    // ── P/Invoke + constants ───────────────────────────────────────────

    private const int WM_NCLBUTTONDOWN = 0xA1;
    private const int HTCAPTION = 2;

    // DWM (Win10 2004+ / Win11)
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWA_SYSTEMBACKDROP_TYPE = 38;
    private const int DWMWCP_ROUND = 2;
    private const int DWMSBT_MAINWINDOW = 2;       // Mica
    private const int DWMSBT_TRANSIENTWINDOW = 3;  // Acrylic

    [StructLayout(LayoutKind.Sequential)]
    private struct MARGINS { public int Left, Right, Top, Bottom; }

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern nint SendMessage(nint hWnd, int msg, nint wParam, nint lParam);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(nint hwnd, int attr, ref int value, int size);

    [DllImport("dwmapi.dll")]
    private static extern int DwmExtendFrameIntoClientArea(nint hwnd, ref MARGINS margins);
}
