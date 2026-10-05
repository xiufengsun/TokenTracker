using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace TokenTrackerWin;

/// <summary>A tray-owned quota surface. It creates WebView2 only while enabled.</summary>
internal sealed class QuotaWidgetWindow : Window
{
    private const int MaxRecoveryAttempts = 2;
    private const uint EventSystemForeground = 0x0003;
    private const uint EventObjectLocationChange = 0x800B;
    private const uint WineventOutOfContext = 0x0000;

    private readonly ServerManager _server;
    private readonly WidgetWebViewEnvironment _webViewEnvironment;
    private readonly Action _openDashboard;
    private readonly QuotaWidgetSettings _settings;
    private readonly WinEventDelegate _winEventCallback;
    private WebView2CompositionControl? _view;
    private JsonNode? _limits;
    private bool _failed;
    private bool _ready;
    private bool _closed;
    private bool _expanded;
    private bool _placed;
    private bool _fullscreenHidden;
    private bool _light;
    private bool _recoveryInFlight;
    private int _recoveryAttempts;
    private int _generation;
    private int _fullscreenCheckQueued;
    private Task? _initializationTask;
    private string _locale;
    private string? _lastContext;
    private nint _hwnd;
    private nint _foregroundHook;
    private nint _locationChangeHook;
    private (int Width, int Height, int Radius) _regionSize;

    public bool Enabled => _settings.Enabled;
    public event Action? EnabledChanged;

    public QuotaWidgetWindow(
        ServerManager server,
        Action openDashboard,
        WidgetWebViewEnvironment webViewEnvironment)
    {
        _server = server;
        _openDashboard = openDashboard;
        _webViewEnvironment = webViewEnvironment;
        _settings = QuotaWidgetSettings.Load();
        _locale = NativeLocalization.CurrentResolvedLocale;
        _light = NativeTheme.ResolveIsLight(NativeTheme.CurrentPreference);
        _winEventCallback = OnWinEvent;

        Title = Constants.AppDisplayName;
        Width = 320;
        Height = 144;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true;
        Background = System.Windows.Media.Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        SourceInitialized += (_, _) =>
        {
            _hwnd = new WindowInteropHelper(this).Handle;
            // Tool window: excluded from Alt+Tab. Explicit clicks can still focus controls.
            SetWindowLongPtr(_hwnd, -20, GetWindowLongPtr(_hwnd, -20) | 0x80);
            HwndSource.FromHwnd(_hwnd)?.AddHook(WindowMessage);
        };
        IsVisibleChanged += (_, _) => OnVisibilityChanged();
        _server.StatusChanged += ServerChanged;
        Closing += (_, e) =>
        {
            if (_closed) return;
            e.Cancel = true;
            SetEnabled(false);
        };
    }

    public void SetEnabled(bool enabled)
    {
        if (_closed) return;
        var wasEnabled = _settings.Enabled;
        _settings.Enabled = enabled;
        _settings.Save();

        if (enabled)
        {
            if (!wasEnabled)
            {
                _recoveryAttempts = 0;
                _expanded = false;
                Width = 320;
                Height = 144;
            }
            EnsureView();
            if (!IsVisible) Show();
            StartFullscreenMonitoring();
            CheckFullscreenState();
            if (IsVisible)
            {
                Place(!_placed);
                _placed = true;
            }
            EnsureInitialized();
        }
        else
        {
            _fullscreenHidden = false;
            StopFullscreenMonitoring();
            Hide();
            ReleaseView();
        }

        EnabledChanged?.Invoke();
    }

    public void ApplyLimits(string json)
    {
        try { _limits = JsonNode.Parse(json); _failed = false; }
        catch (JsonException) { _failed = true; }
        PushContext();
    }

    public void ApplyLocale(string locale)
    {
        if (_locale == locale) return;
        _locale = locale;
        if (_view is null && Content is System.Windows.Controls.Button button)
            button.Content = TrayStrings.For(_locale).DesktopQuota;
        _lastContext = null;
        PushContext();
    }

    public void ApplyTheme(bool light)
    {
        if (_light == light) return;
        _light = light;
        _lastContext = null;
        PushContext();
    }

    public void MarkFailed()
    {
        _failed = true;
        PushContext();
    }

    private WebView2CompositionControl EnsureView()
    {
        if (_view is not null) return _view;
        var view = new WebView2CompositionControl { AllowExternalDrop = false };
        _view = view;
        Content = view;
        _placed = false;
        return view;
    }

    private void EnsureInitialized()
    {
        if (!_settings.Enabled || _closed) return;
        var view = EnsureView();
        if (_initializationTask is { IsCompleted: false }) return;
        _initializationTask = InitializeAsync(view, _generation);
    }

    private async Task InitializeAsync(WebView2CompositionControl view, int generation)
    {
        try
        {
            if (view.CoreWebView2 is not null || !IsCurrent(view, generation)) return;
            var environment = await _webViewEnvironment.GetAsync();
            if (!IsCurrent(view, generation)) return;
            await view.EnsureCoreWebView2Async(environment);
            if (!IsCurrent(view, generation)) return;

            view.DefaultBackgroundColor = System.Drawing.Color.Transparent;
            var core = view.CoreWebView2 ?? throw new InvalidOperationException("WebView2 initialization did not create a core.");
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.NavigationStarting += (_, e) =>
            {
                if (!IsCurrent(view, generation)) return;
                if (!AllowedSource(e.Uri)) e.Cancel = true;
                _ready = false;
            };
            core.WebMessageReceived += ReceiveMessage;
            core.ProcessFailed += (_, e) => OnProcessFailed(core, view, generation, e.ProcessFailedKind);
            Navigate();
        }
        catch (Exception ex)
        {
            if (!IsCurrent(view, generation)) return;
            Diag.Log("quota", $"initialization failed: {ex.Message}");
            ShowFallback(view, generation);
        }
    }

    private bool IsCurrent(WebView2CompositionControl view, int generation) =>
        !_closed && _settings.Enabled && _generation == generation && ReferenceEquals(_view, view);

    private void ShowFallback(WebView2CompositionControl view, int generation)
    {
        if (!IsCurrent(view, generation)) return;
        _generation++;
        _view = null;
        _initializationTask = null;
        _ready = false;
        _recoveryInFlight = false;
        Content = CreateFallbackButton();
        view.Dispose();
    }

    private System.Windows.Controls.Button CreateFallbackButton()
    {
        var button = new System.Windows.Controls.Button { Content = TrayStrings.For(_locale).DesktopQuota, Padding = new Thickness(12, 8, 12, 8) };
        button.Click += (_, _) => _openDashboard();
        return button;
    }

    private bool AllowedSource(string source) => Uri.TryCreate(source, UriKind.Absolute, out var uri)
        && Uri.TryCreate(_server.BaseUrl, UriKind.Absolute, out var server)
        && uri.Scheme == server.Scheme && uri.Authority == server.Authority && uri.AbsolutePath == "/quota.html";

    private void ReceiveMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!AllowedSource(e.Source) || _closed || !_settings.Enabled
            || _view?.CoreWebView2 is not { } core || !ReferenceEquals(sender, core)) return;
        string message;
        try { message = e.TryGetWebMessageAsString(); }
        catch (ArgumentException) { return; }
        switch (message)
        {
            case "quota:ready": _ready = true; ResizeWidget(false); _lastContext = null; PushContext(); break;
            case "quota:expand": ResizeWidget(true); break;
            case "quota:collapse": ResizeWidget(false); break;
            case "quota:close": SetEnabled(false); break;
            case "quota:dashboard": _openDashboard(); break;
            case "quota:drag":
                ReleaseCapture();
                SendMessage(_hwnd, 0xA1, (nint)2, 0);
                Place(false);
                if (GetWindowRect(_hwnd, out var rect)) { _settings.X = rect.Left; _settings.Y = rect.Top; _settings.Save(); }
                break;
            default:
                if (message.Length > 1024) return;
                try
                {
                    using var doc = JsonDocument.Parse(message);
                    var root = doc.RootElement;
                    if (root.GetProperty("type").GetString() != "quota:select") return;
                    var ids = root.GetProperty("ids").EnumerateArray().Select(value => value.GetString()).ToArray();
                    if (ids.Length > 2 || ids.Any(id => string.IsNullOrEmpty(id) || id.Length > 100)) return;
                    _settings.Selected = ids.Select(id => id!).Distinct().ToArray();
                    _settings.Save();
                    _lastContext = null;
                    PushContext();
                }
                catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException) { }
                break;
        }
    }

    private void OnProcessFailed(
        CoreWebView2 core,
        WebView2CompositionControl view,
        int generation,
        CoreWebView2ProcessFailedKind kind)
    {
        if (!IsCurrent(view, generation) || !ReferenceEquals(_view?.CoreWebView2, core)) return;
        if (kind is not (CoreWebView2ProcessFailedKind.RenderProcessExited
            or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive
            or CoreWebView2ProcessFailedKind.BrowserProcessExited)) return;
        Diag.Log("quota", $"webview process failed kind={kind}");
        _ready = false;
        _lastContext = null;
        if (_recoveryInFlight) return;
        if (_recoveryAttempts >= MaxRecoveryAttempts)
        {
            ShowFallback(view, generation);
            return;
        }

        _recoveryAttempts++;
        _recoveryInFlight = true;
        try { Dispatcher.BeginInvoke(new Action(() => _ = RecoverAsync(core, view, generation, _recoveryAttempts, kind))); }
        catch { _recoveryInFlight = false; ShowFallback(view, generation); }
    }

    private async Task RecoverAsync(
        CoreWebView2 core,
        WebView2CompositionControl view,
        int generation,
        int attempt,
        CoreWebView2ProcessFailedKind kind)
    {
        try
        {
            var recovered = kind != CoreWebView2ProcessFailedKind.BrowserProcessExited
                && await TryReloadAsync(core);
            if (!IsCurrent(view, generation)) return;
            if (!recovered) await RecreateViewAsync(view, generation);
        }
        catch (Exception ex)
        {
            if (IsCurrent(view, generation))
            {
                Diag.Log("quota", $"recovery attempt {attempt} failed: {ex.Message}");
                ShowFallback(view, generation);
            }
        }
        finally
        {
            if (IsCurrent(view, generation)) _recoveryInFlight = false;
        }
    }

    private static async Task<bool> TryReloadAsync(CoreWebView2 core)
    {
        var completed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        EventHandler<CoreWebView2NavigationCompletedEventArgs> handler = (_, e) => completed.TrySetResult(e.IsSuccess);
        core.NavigationCompleted += handler;
        try { core.Reload(); }
        catch
        {
            core.NavigationCompleted -= handler;
            return false;
        }

        var finished = await Task.WhenAny(completed.Task, Task.Delay(TimeSpan.FromSeconds(5)));
        core.NavigationCompleted -= handler;
        return finished == completed.Task && await completed.Task;
    }

    private async Task RecreateViewAsync(WebView2CompositionControl oldView, int oldGeneration)
    {
        if (!IsCurrent(oldView, oldGeneration)) return;
        ReleaseView();
        if (!_settings.Enabled || _closed) return;
        var view = EnsureView();
        var generation = _generation;
        _initializationTask = InitializeAsync(view, generation);
        await _initializationTask;
        if (IsCurrent(view, generation)) _recoveryInFlight = false;
    }

    private void ReleaseView()
    {
        _generation++;
        _initializationTask = null;
        _recoveryInFlight = false;
        _ready = false;
        _lastContext = null;
        var old = _view;
        _view = null;
        Content = null;
        old?.Dispose();
    }

    private void ResizeWidget(bool expanded)
    {
        _expanded = expanded;
        Width = expanded ? 360 : 320;
        Height = expanded ? 340 : 144;
        Place(false);
    }

    private void ServerChanged(ServerManager.ServerStatus status)
    {
        if (_closed || !_settings.Enabled) return;
        Dispatcher.BeginInvoke(new Action(() =>
        {
            if (_closed || !_settings.Enabled) return;
            if (status == ServerManager.ServerStatus.Running) Navigate();
            else MarkFailed();
        }));
    }

    private void Navigate()
    {
        if (!_closed && _settings.Enabled && _view?.CoreWebView2 is { } core
            && _server.Status == ServerManager.ServerStatus.Running)
            core.Navigate(_server.BaseUrl + "/quota.html?app=1");
    }

    private void PushContext()
    {
        if (!_ready || _closed || !_settings.Enabled || !IsVisible || _view?.CoreWebView2 is not { } core) return;
        var json = JsonSerializer.Serialize(new
        {
            type = "quota:context", limits = _limits, failed = _failed,
            selected = _settings.Selected,
            locale = _locale,
            light = _light,
        });
        if (json == _lastContext) return;
        try { core.PostWebMessageAsJson(json); _lastContext = json; }
        catch (InvalidOperationException) { _ready = false; }
    }

    private void StartFullscreenMonitoring()
    {
        if (_hwnd == 0) return;
        if (_foregroundHook == 0)
            _foregroundHook = SetWinEventHook(
                EventSystemForeground, EventSystemForeground, 0, _winEventCallback, 0, 0,
                WineventOutOfContext);
        if (_locationChangeHook == 0)
            _locationChangeHook = SetWinEventHook(
                EventObjectLocationChange, EventObjectLocationChange, 0, _winEventCallback, 0, 0,
                WineventOutOfContext);
        if (_foregroundHook == 0 || _locationChangeHook == 0)
            Diag.Log("quota", "fullscreen event hook could not be installed");
    }

    private void StopFullscreenMonitoring()
    {
        if (_foregroundHook != 0) UnhookWinEvent(_foregroundHook);
        if (_locationChangeHook != 0) UnhookWinEvent(_locationChangeHook);
        _foregroundHook = 0;
        _locationChangeHook = 0;
    }

    private void OnWinEvent(nint hook, uint eventType, nint hwnd, int idObject, int idChild, uint eventThread, uint eventTime)
    {
        if (eventType == EventObjectLocationChange
            && (idObject != 0 || idChild != 0 || hwnd != GetForegroundWindow())) return;
        QueueFullscreenCheck();
    }

    private void QueueFullscreenCheck()
    {
        if (Interlocked.Exchange(ref _fullscreenCheckQueued, 1) != 0) return;
        try
        {
            Dispatcher.BeginInvoke(new Action(() =>
            {
                Interlocked.Exchange(ref _fullscreenCheckQueued, 0);
                CheckFullscreenState();
            }));
        }
        catch { Interlocked.Exchange(ref _fullscreenCheckQueued, 0); }
    }

    private void CheckFullscreenState()
    {
        if (_closed || !_settings.Enabled) return;
        if (ForegroundIsFullscreen())
        {
            if (IsVisible)
            {
                _fullscreenHidden = true;
                Hide();
            }
        }
        else if (_fullscreenHidden)
        {
            _fullscreenHidden = false;
            if (!IsVisible) Show();
            Place(false);
        }
    }

    private void OnVisibilityChanged()
    {
        if (IsVisible && !_closed && _settings.Enabled)
        {
            Place(!_placed);
            _placed = true;
            _lastContext = null;
            PushContext();
        }
    }

    private void Place(bool restore)
    {
        if (_hwnd == 0) return;
        var scale = GetDpiForWindow(_hwnd) / 96d;
        var width = (int)Math.Round(Width * scale);
        var height = (int)Math.Round(Height * scale);
        GetWindowRect(_hwnd, out var rect);
        var x = restore ? _settings.X : rect.Left;
        var y = restore ? _settings.Y : rect.Top;
        var screen = x.HasValue && y.HasValue ? Screen.FromPoint(new System.Drawing.Point(x.Value, y.Value)) : Screen.PrimaryScreen!;
        var work = screen.WorkingArea;
        var left = Math.Clamp(x ?? work.Right - width - 16, work.Left, Math.Max(work.Left, work.Right - width));
        var top = Math.Clamp(y ?? work.Top + work.Height / 3, work.Top, Math.Max(work.Top, work.Bottom - height));
        if (rect.Left != left || rect.Top != top || rect.Right - rect.Left != width || rect.Bottom - rect.Top != height)
            SetWindowPos(_hwnd, 0, left, top, width, height, 0x14); // NOZORDER | NOACTIVATE
        var radius = (int)((_expanded ? 20 : 18) * scale * 2);
        if (_regionSize != (width, height, radius))
        {
            var region = CreateRoundRectRgn(0, 0, width + 1, height + 1, radius, radius);
            if (SetWindowRgn(_hwnd, region, true) == 0) DeleteObject(region);
            else _regionSize = (width, height, radius);
        }
    }

    private nint WindowMessage(nint hwnd, int message, nint wParam, nint lParam, ref bool handled)
    {
        if (message is 0x02E0 or 0x007E) Dispatcher.BeginInvoke(new Action(() => { if (!_closed) Place(false); }));
        return 0;
    }

    private bool ForegroundIsFullscreen()
    {
        var foreground = GetForegroundWindow();
        if (foreground == 0 || foreground == _hwnd || !GetWindowRect(foreground, out var rect)) return false;
        var className = new System.Text.StringBuilder(256);
        GetClassName(foreground, className, className.Capacity);
        if (className.ToString() is "Progman" or "WorkerW") return false;
        var screen = Screen.FromHandle(_hwnd);
        var bounds = screen.Bounds;
        return rect.Left <= bounds.Left && rect.Top <= bounds.Top && rect.Right >= bounds.Right && rect.Bottom >= bounds.Bottom;
    }

    public void Shutdown()
    {
        if (_closed) return;
        _closed = true;
        StopFullscreenMonitoring();
        _server.StatusChanged -= ServerChanged;
        ReleaseView();
        Close();
    }

    private delegate void WinEventDelegate(nint hook, uint eventType, nint hwnd, int idObject, int idChild, uint eventThread, uint eventTime);

    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(nint hwnd, System.Text.StringBuilder value, int size);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern nint GetWindowLongPtr(nint hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern nint SetWindowLongPtr(nint hwnd, int index, nint value);
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern nint SendMessage(nint hwnd, int message, nint wParam, nint lParam);
    [DllImport("gdi32.dll")] private static extern nint CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(nint hwnd, nint region, bool redraw);
    [DllImport("user32.dll")] private static extern bool DeleteObject(nint obj);
    [DllImport("user32.dll")] private static extern nint SetWinEventHook(uint eventMin, uint eventMax, nint eventHookModule, WinEventDelegate eventHook, uint processId, uint threadId, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(nint eventHook);
}
