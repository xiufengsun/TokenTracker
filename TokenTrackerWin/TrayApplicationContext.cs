using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace TokenTrackerWin;

/// <summary>
/// The resident tray controller — Windows counterpart of
/// <c>StatusBarController.swift</c>. Owns the NotifyIcon, the right-click menu,
/// the server lifecycle, the usage poller and the (lazily created) dashboard window.
/// </summary>
internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly System.Windows.Threading.Dispatcher _uiDispatcher =
        System.Windows.Application.Current?.Dispatcher
        ?? System.Windows.Threading.Dispatcher.CurrentDispatcher;
    private readonly NotifyIcon _trayIcon;
    private readonly ServerManager _server = new();
    private readonly UsagePoller _poller;
    private DashboardWindow? _dashboard;
    private PetWindow? _petWindow;

    private readonly ContextMenuStrip _menu;
    private readonly TrayMenuRenderer _menuRenderer;
    private readonly ToolStripMenuItem _summaryItem;
    private readonly ToolStripMenuItem _openDashboardItem;
    private readonly ToolStripMenuItem _syncItem;
    private readonly ToolStripMenuItem _petItem;
    private readonly ToolStripMenuItem _petSizeItem;
    private readonly ToolStripMenuItem _petSizeSmall;
    private readonly ToolStripMenuItem _petSizeMedium;
    private readonly ToolStripMenuItem _petSizeLarge;
    private readonly ToolStripMenuItem _petCharacterItem;
    private readonly ToolStripMenuItem _petCharacterClawd;
    private readonly ToolStripMenuItem _petCharacterSprout;
    private readonly ToolStripMenuItem _petCharacterByte;
    private readonly ToolStripMenuItem _petCharacterEmber;
    private readonly ToolStripMenuItem _petCharacterBot;
    private readonly ToolStripMenuItem _startupItem;
    private readonly ToolStripMenuItem _checkUpdatesItem;

    // Right-click-the-pet context menu (separate ToolStrip items — an item can't
    // live in two menus at once).
    private readonly ContextMenuStrip _petMenu;
    private readonly ToolStripMenuItem _petCtxOpen;
    private readonly ToolStripMenuItem _petCtxSync;
    private readonly ToolStripMenuItem _petCtxSizeItem;
    private readonly ToolStripMenuItem _petCtxSizeSmall;
    private readonly ToolStripMenuItem _petCtxSizeMedium;
    private readonly ToolStripMenuItem _petCtxSizeLarge;
    private readonly ToolStripMenuItem _petCtxCharacterItem;
    private readonly ToolStripMenuItem _petCtxCharacterClawd;
    private readonly ToolStripMenuItem _petCtxCharacterSprout;
    private readonly ToolStripMenuItem _petCtxCharacterByte;
    private readonly ToolStripMenuItem _petCtxCharacterEmber;
    private readonly ToolStripMenuItem _petCtxCharacterBot;
    private readonly ToolStripMenuItem _petCtxClose;
    private readonly ToolStripMenuItem _starItem;
    private readonly ToolStripMenuItem _quitItem;

    private UsagePoller.UsageStats? _lastStats;
    private string? _lastLimitsJson;
    private bool _isSyncing;
    private string _localePreference = NativeLocalization.CurrentPreference;
    private string _themePreference = NativeTheme.CurrentPreference;
    private TrayStrings _strings = TrayStrings.For(NativeLocalization.CurrentResolvedLocale);
    private TrayMenuRenderer.Palette _menuPalette =
        TrayMenuRenderer.PaletteFor(NativeTheme.ResolveIsLight(NativeTheme.CurrentPreference));
    private Font? _menuFont;
    private Font? _summaryFont;

    private readonly UpdateChecker _updateChecker = new();
    private UpdateStrings _updateStrings = UpdateStrings.For(NativeLocalization.CurrentResolvedLocale);
    private bool _updateBalloonShown;

    // Lightweight UI-thread tick so the tooltip follows a currency change within a
    // couple of seconds without needing a right-click. Cheap: it only touches the
    // WebView (to read the currency) once the dashboard has been opened.
    private readonly System.Windows.Forms.Timer _refreshTimer = new() { Interval = 2000 };
    private readonly System.Windows.Forms.Timer _syncTimer = new() { Interval = 5 * 60 * 1000 };

    public TrayApplicationContext(bool showPetOnLaunch = false)
    {
        _poller = new UsagePoller(() => _server.BaseUrl);
        _menuRenderer = new TrayMenuRenderer(_menuPalette);

        _summaryItem = CreateMenuItem("", (_, _) => OpenDashboard());
        _openDashboardItem = CreateMenuItem("", (_, _) => OpenDashboard());
        _syncItem = CreateMenuItem("", (_, _) => _server.TriggerSync());
        _petItem = CreateMenuItem("", (_, _) => TogglePet());
        _petSizeSmall = CreateMenuItem("", (_, _) => SetPetSize(PetWindow.SizeSmall));
        _petSizeMedium = CreateMenuItem("", (_, _) => SetPetSize(PetWindow.SizeMedium));
        _petSizeLarge = CreateMenuItem("", (_, _) => SetPetSize(PetWindow.SizeLarge));
        _petSizeItem = CreateMenuItem("", (_, _) => { });
        _petSizeItem.DropDownItems.Add(_petSizeSmall);
        _petSizeItem.DropDownItems.Add(_petSizeMedium);
        _petSizeItem.DropDownItems.Add(_petSizeLarge);
        StyleSubmenu(_petSizeItem.DropDown);
        _petCharacterClawd = CreateMenuItem("", (_, _) => SetPetCharacter(PetWindow.CharacterClawd));
        _petCharacterBot = CreateMenuItem("", (_, _) => SetPetCharacter(PetWindow.CharacterBot));
        _petCharacterSprout = CreateMenuItem("", (_, _) => SetPetCharacter(PetWindow.CharacterSprout));
        _petCharacterByte = CreateMenuItem("", (_, _) => SetPetCharacter(PetWindow.CharacterByte));
        _petCharacterEmber = CreateMenuItem("", (_, _) => SetPetCharacter(PetWindow.CharacterEmber));
        _petCharacterItem = CreateMenuItem("", (_, _) => { });
        _petCharacterItem.DropDownItems.AddRange([
            _petCharacterClawd, _petCharacterBot, _petCharacterSprout, _petCharacterByte, _petCharacterEmber]);
        StyleSubmenu(_petCharacterItem.DropDown);

        // Pet right-click context menu: open/close dashboard / size / close pet.
        // The first item toggles the dashboard; its label flips to "Close" while it's open.
        _petCtxOpen = CreateMenuItem("", (_, _) => ToggleDashboard());
        _petCtxSync = CreateMenuItem("", (_, _) => _server.TriggerSync());
        _petCtxSizeSmall = CreateMenuItem("", (_, _) => SetPetSize(PetWindow.SizeSmall));
        _petCtxSizeMedium = CreateMenuItem("", (_, _) => SetPetSize(PetWindow.SizeMedium));
        _petCtxSizeLarge = CreateMenuItem("", (_, _) => SetPetSize(PetWindow.SizeLarge));
        _petCtxSizeItem = CreateMenuItem("", (_, _) => { });
        _petCtxSizeItem.DropDownItems.Add(_petCtxSizeSmall);
        _petCtxSizeItem.DropDownItems.Add(_petCtxSizeMedium);
        _petCtxSizeItem.DropDownItems.Add(_petCtxSizeLarge);
        _petCtxCharacterClawd = CreateMenuItem("", (_, _) => SetPetCharacter(PetWindow.CharacterClawd));
        _petCtxCharacterBot = CreateMenuItem("", (_, _) => SetPetCharacter(PetWindow.CharacterBot));
        _petCtxCharacterSprout = CreateMenuItem("", (_, _) => SetPetCharacter(PetWindow.CharacterSprout));
        _petCtxCharacterByte = CreateMenuItem("", (_, _) => SetPetCharacter(PetWindow.CharacterByte));
        _petCtxCharacterEmber = CreateMenuItem("", (_, _) => SetPetCharacter(PetWindow.CharacterEmber));
        _petCtxCharacterItem = CreateMenuItem("", (_, _) => { });
        _petCtxCharacterItem.DropDownItems.AddRange([
            _petCtxCharacterClawd, _petCtxCharacterBot, _petCtxCharacterSprout, _petCtxCharacterByte, _petCtxCharacterEmber]);
        _petCtxClose = CreateMenuItem("", (_, _) => ClosePet());
        _petMenu = new ContextMenuStrip
        {
            AllowTransparency = true,
            DropShadowEnabled = false,
            Renderer = _menuRenderer,
            BackColor = _menuPalette.MenuBackground,
            ForeColor = _menuPalette.Text,
            Padding = new Padding(6),
            ShowCheckMargin = true,
            ShowImageMargin = false,
        };
        _petMenu.Items.Add(_petCtxOpen);
        _petMenu.Items.Add(_petCtxSync);
        _petMenu.Items.Add(_petCtxSizeItem);
        _petMenu.Items.Add(_petCtxCharacterItem);
        _petMenu.Items.Add(CreateSeparator());
        _petMenu.Items.Add(_petCtxClose);
        StyleSubmenu(_petCtxSizeItem.DropDown);
        StyleSubmenu(_petCtxCharacterItem.DropDown);
        _petMenu.Opened += (_, _) => TrayMenuRenderer.ApplyRoundedRegion(_petMenu);
        _petMenu.SizeChanged += (_, _) => TrayMenuRenderer.ApplyRoundedRegion(_petMenu);
        _petMenu.Opening += (_, _) => { RebuildCustomPetMenus(); UpdatePetSizeChecks(); UpdatePetCharacterChecks(); UpdatePetDashboardItem(); };

        _startupItem = CreateMenuItem("", OnToggleStartup);
        _startupItem.Checked = LaunchAtStartup.IsEnabled;
        _startupItem.CheckOnClick = false;
        _checkUpdatesItem = CreateMenuItem("", (_, _) => OnCheckUpdatesClicked());
        _starItem = CreateMenuItem("", (_, _) => OpenInBrowser(Constants.GitHubUrl));
        _quitItem = CreateMenuItem("", (_, _) => Quit());

        _menu = new ContextMenuStrip
        {
            AllowTransparency = true,
            DropShadowEnabled = false,
            Renderer = _menuRenderer,
            BackColor = _menuPalette.MenuBackground,
            ForeColor = _menuPalette.Text,
            Padding = new Padding(6),
            ShowCheckMargin = true,
            ShowImageMargin = false,
        };
        _menu.Items.Add(_summaryItem);
        _menu.Items.Add(CreateSeparator());
        _menu.Items.Add(_openDashboardItem);
        _menu.Items.Add(_syncItem);
        _menu.Items.Add(_petItem);
        _menu.Items.Add(_petSizeItem);
        _menu.Items.Add(_petCharacterItem);
        _menu.Items.Add(CreateSeparator());
        _menu.Items.Add(_startupItem);
        _menu.Items.Add(_checkUpdatesItem);
        _menu.Items.Add(_starItem);
        _menu.Items.Add(CreateSeparator());
        _menu.Items.Add(_quitItem);
        ApplyLocaleToMenu();
        _menu.Opened += (_, _) => TrayMenuRenderer.ApplyRoundedRegion(_menu);
        _menu.SizeChanged += (_, _) => TrayMenuRenderer.ApplyRoundedRegion(_menu);

        // Re-read the currency every time the menu opens so the cost is always
        // current (belt-and-suspenders alongside the WebView change notification).
        _menu.Opening += (_, _) =>
        {
            RefreshThemeFromDashboard();
            RefreshLocaleFromDashboard();
            RefreshSummary();
            UpdatePetMenuText();
            RebuildCustomPetMenus();
            UpdatePetSizeChecks();
            UpdatePetCharacterChecks();
        };

        _trayIcon = new NotifyIcon
        {
            Icon = LoadTrayIcon(),
            Text = Constants.AppDisplayName,   // tooltip (≤63 chars)
            Visible = true,
            ContextMenuStrip = _menu,
        };
        // Left-click toggles the dashboard, matching the macOS popover.
        _trayIcon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) ToggleDashboard();
        };

        _server.StatusChanged += OnServerStatusChanged;
        _server.SyncStarted += OnSyncStarted;
        _server.SyncCompleted += OnSyncCompleted;
        _poller.StatsUpdated += OnStatsUpdated;
        _poller.LimitsUpdated += OnLimitsUpdated;
        _refreshTimer.Tick += (_, _) => RefreshSummary();
        _syncTimer.Tick += (_, _) => TriggerBackgroundSync();
        _refreshTimer.Start();
        _ = _server.EnsureServerRunningAsync();

        // Click-to-update: keep the menu item in sync with the checker, quit when it's
        // ready to hand off to the installer, and run one quiet check on launch. The
        // checker self-skips dev builds; installed builds auto-install when enabled.
        _updateChecker.Changed += () => PostToUi(() =>
        {
            RefreshUpdateMenuItem();
            PushDashboardNativeSettings();
        });
        _updateChecker.QuitRequested += () => PostToUi(Quit);
        _ = _updateChecker.CheckAsync(silent: true);

        // The desktop pet is the app's visible presence now — the dashboard no longer
        // auto-opens. A stored preference (user toggled the pet at least once) always
        // wins; only first launches fall back to the show-on-manual-run default.
        // Deferred onto the dispatcher so it shows once the message pump is running.
        if (PetWindow.StoredVisible ?? showPetOnLaunch)
        {
            _uiDispatcher.BeginInvoke(new Action(() =>
            {
                EnsurePet();
                _petWindow!.ShowPet();
                _poller.IncludeRichStats = true;   // gather the pet's quip-pool stats
                _poller.IncludeLimits = true;
                UpdatePetMenuText();
                RefreshSummary();
            }));
        }
    }

    private ToolStripMenuItem CreateMenuItem(string text, EventHandler onClick)
    {
        return new ToolStripMenuItem(text, null, onClick)
        {
            BackColor = _menuPalette.MenuBackground,
            ForeColor = _menuPalette.Text,
            // No horizontal item padding: WinForms ignores it in the menu width
            // calc but includes it in the item bounds, so it overflows right and
            // pushes submenus away from the parent. The left gutter comes from the
            // framework's check-margin column (ShowCheckMargin) instead.
            Margin = new Padding(0, 1, 0, 1),
            Padding = new Padding(0, 6, 0, 6),
        };
    }

    /// <summary>
    /// Match a submenu / popup to the main menu's chrome: shared custom renderer,
    /// background, and — crucially — the rounded Region + DWM corners (without this
    /// the popup is a square window and the rounded paint leaves jagged corner pixels).
    /// </summary>
    private void StyleSubmenu(ToolStripDropDown dropDown)
    {
        dropDown.Renderer = _menuRenderer;
        dropDown.BackColor = _menuPalette.MenuBackground;
        dropDown.Padding = new Padding(6);   // same inner gutter as the main menu
        // The auto-created submenu defaults to ShowImageMargin=true (a left icon
        // column) — turn it off so its layout matches the top-level menu and our
        // padding / check positioning apply consistently.
        if (dropDown is ToolStripDropDownMenu m)
        {
            m.ShowCheckMargin = true;
            m.ShowImageMargin = false;
        }
        dropDown.Opened += (_, _) => TrayMenuRenderer.ApplyRoundedRegion(dropDown);
        dropDown.SizeChanged += (_, _) => TrayMenuRenderer.ApplyRoundedRegion(dropDown);
    }

    private ToolStripSeparator CreateSeparator()
    {
        return new ToolStripSeparator
        {
            BackColor = _menuPalette.MenuBackground,
            ForeColor = _menuPalette.Border,
            Margin = new Padding(0, 4, 0, 4),
        };
    }

    private void ApplyLocaleToMenu()
    {
        _strings = TrayStrings.For(NativeLocalization.ResolveLocale(_localePreference));
        _updateStrings = UpdateStrings.For(NativeLocalization.ResolveLocale(_localePreference));

        _menuFont?.Dispose();
        _summaryFont?.Dispose();
        _menuFont = new Font(_strings.FontFamily, 9.5f, FontStyle.Regular, GraphicsUnit.Point);
        _summaryFont = new Font(_strings.FontFamily, 9.5f, FontStyle.Bold, GraphicsUnit.Point);

        _menu.Font = _menuFont;
        _summaryItem.Font = _summaryFont;
        _summaryItem.Text = $"{_strings.TodayTitle}: {_strings.NoData}";
        _openDashboardItem.Text = _strings.OpenDashboard;
        _syncItem.Text = _strings.SyncNow;
        UpdatePetMenuText();
        _petSizeItem.Text = _strings.PetSize;
        _petSizeSmall.Text = _strings.SizeSmall;
        _petSizeMedium.Text = _strings.SizeMedium;
        _petSizeLarge.Text = _strings.SizeLarge;
        _petCharacterItem.Text = _strings.PetCharacter;
        _petCharacterClawd.Text = _strings.CharacterClawd;
        _petCharacterSprout.Text = _strings.CharacterSprout;
        _petCharacterByte.Text = _strings.CharacterByte;
        _petCharacterEmber.Text = _strings.CharacterEmber;
        _petCharacterBot.Text = _strings.CharacterBot;
        // Pet right-click context menu.
        _petMenu.Font = _menuFont;
        _petCtxOpen.Text = _strings.OpenDashboard;
        _petCtxSync.Text = _strings.SyncNow;
        _petCtxSizeItem.Text = _strings.PetSize;
        _petCtxSizeSmall.Text = _strings.SizeSmall;
        _petCtxSizeMedium.Text = _strings.SizeMedium;
        _petCtxSizeLarge.Text = _strings.SizeLarge;
        _petCtxCharacterItem.Text = _strings.PetCharacter;
        _petCtxCharacterClawd.Text = _strings.CharacterClawd;
        _petCtxCharacterSprout.Text = _strings.CharacterSprout;
        _petCtxCharacterByte.Text = _strings.CharacterByte;
        _petCtxCharacterEmber.Text = _strings.CharacterEmber;
        _petCtxCharacterBot.Text = _strings.CharacterBot;
        _petCtxClose.Text = _strings.ClosePet;
        UpdatePetSizeChecks();
        UpdatePetCharacterChecks();
        _startupItem.Text = _strings.LaunchAtLogin;
        _starItem.Text = _strings.StarOnGitHub;
        _quitItem.Text = _strings.Quit;
        RefreshUpdateMenuItem();

        ApplyThemeToMenu();

        RefreshSummary();
    }

    private void ApplyThemeToMenu()
    {
        _menuRenderer.SetPalette(_menuPalette);
        _menu.BackColor = _menuPalette.MenuBackground;
        _menu.ForeColor = _menuPalette.Text;

        foreach (ToolStripItem item in _menu.Items)
        {
            item.BackColor = _menuPalette.MenuBackground;
            item.ForeColor = item is ToolStripSeparator
                ? _menuPalette.Border
                : item.Enabled ? _menuPalette.Text : _menuPalette.DisabledText;
        }

        _menu.Invalidate(true);

        // Pet right-click menu shares the renderer; just keep its background in sync
        // (text/hover are painted by the renderer from the current palette).
        if (_petMenu is not null)
        {
            _petMenu.BackColor = _menuPalette.MenuBackground;
            _petMenu.Invalidate(true);
        }
    }

    private void ApplyThemePreference(string preference)
    {
        var normalized = NativeTheme.NormalizePreference(preference);
        var nextPalette = TrayMenuRenderer.PaletteFor(NativeTheme.ResolveIsLight(normalized));
        if (_themePreference == normalized && _menuPalette == nextPalette) return;

        _themePreference = normalized;
        _menuPalette = nextPalette;
        NativeTheme.StorePreference(normalized);
        ApplyThemeToMenu();
    }

    private async void RefreshThemeFromDashboard()
    {
        var preference = _dashboard is not null
            ? await _dashboard.ReadThemePreferenceAsync()
            : NativeTheme.CurrentPreference;
        ApplyThemePreference(preference);
    }

    private async void RefreshLocaleFromDashboard()
    {
        var preference = _dashboard is not null
            ? await _dashboard.ReadLocalePreferenceAsync()
            : NativeLocalization.CurrentPreference;
        preference = NativeLocalization.NormalizePreference(preference);
        if (_localePreference == preference) return;

        _localePreference = preference;
        NativeLocalization.StorePreference(preference);
        ApplyLocaleToMenu();
    }

    private void OpenDashboard()
    {
        EnsureDashboard();
        _dashboard!.ShowDashboard();
    }

    private void ToggleDashboard()
    {
        EnsureDashboard();
        _dashboard!.ToggleDashboard();
    }

    private void TogglePet()
    {
        EnsurePet();
        _petWindow!.TogglePet();
        _petWindow.StoreVisible(_petWindow.IsVisible);
        UpdatePetMenuText();
        // The pet's quip pool needs the heatmap + model-breakdown stats; only gather them
        // (two extra calls per poll) while the pet is actually on screen.
        _poller.IncludeRichStats = _petWindow.IsVisible;
        _poller.IncludeLimits = _petWindow.IsVisible;
        if (_petWindow.IsVisible)
        {
            RefreshSummary();      // push the current numbers right away
            _poller.RefreshNow();  // and fetch the freshest (now incl. rich stats)
        }
        PushDashboardPetSettings();
    }

    private void EnsurePet()
    {
        if (_petWindow is not null) return;
        _petWindow = new PetWindow(_server);
        // Right-clicking the pet pops a context menu (open dashboard / size / close).
        _petWindow.ContextMenuRequested += () => PostToUi(ShowPetContextMenu);
    }

    /// <summary>Toggle the menu label between "Show" / "Hide" based on current visibility.</summary>
    private void UpdatePetMenuText()
    {
        var visible = _petWindow?.IsVisible == true;
        _petItem.Text = visible ? _strings.HidePet : _strings.ShowPet;
    }

    private void SetPetSize(string size)
    {
        var normalized = PetWindow.NormalizeSize(size);
        if (_petWindow is not null) _petWindow.ApplySize(normalized);
        else PetWindow.PersistSize(normalized);
        UpdatePetSizeChecks(normalized);
        PushDashboardPetSettings();
    }

    /// <summary>Tick the active size in both the tray submenu and the pet context menu.</summary>
    private void UpdatePetSizeChecks(string? size = null)
    {
        var s = PetWindow.NormalizeSize(size ?? PetWindow.CurrentSize);
        _petSizeSmall.Checked = s == PetWindow.SizeSmall;
        _petSizeMedium.Checked = s == PetWindow.SizeMedium;
        _petSizeLarge.Checked = s == PetWindow.SizeLarge;
        _petCtxSizeSmall.Checked = s == PetWindow.SizeSmall;
        _petCtxSizeMedium.Checked = s == PetWindow.SizeMedium;
        _petCtxSizeLarge.Checked = s == PetWindow.SizeLarge;
    }

    private void SetPetCharacter(string character)
    {
        var normalized = PetWindow.NormalizeCharacter(character);
        if (_petWindow is not null) _petWindow.ApplyCharacter(normalized);
        else PetWindow.PersistCharacter(normalized);
        UpdatePetCharacterChecks(normalized);
        PushDashboardPetSettings();
    }

    private void UpdatePetCharacterChecks(string? character = null)
    {
        var selected = PetWindow.NormalizeCharacter(character ?? PetWindow.CurrentCharacter);
        _petCharacterClawd.Checked = selected == PetWindow.CharacterClawd;
        _petCharacterSprout.Checked = selected == PetWindow.CharacterSprout;
        _petCharacterByte.Checked = selected == PetWindow.CharacterByte;
        _petCharacterEmber.Checked = selected == PetWindow.CharacterEmber;
        _petCharacterBot.Checked = selected == PetWindow.CharacterBot;
        _petCtxCharacterClawd.Checked = selected == PetWindow.CharacterClawd;
        _petCtxCharacterSprout.Checked = selected == PetWindow.CharacterSprout;
        _petCtxCharacterByte.Checked = selected == PetWindow.CharacterByte;
        _petCtxCharacterEmber.Checked = selected == PetWindow.CharacterEmber;
        _petCtxCharacterBot.Checked = selected == PetWindow.CharacterBot;
        foreach (ToolStripItem item in _petCharacterItem.DropDownItems)
        {
            if (item.Tag is string id) ((ToolStripMenuItem)item).Checked = selected == id;
        }
        foreach (ToolStripItem item in _petCtxCharacterItem.DropDownItems)
        {
            if (item.Tag is string id) ((ToolStripMenuItem)item).Checked = selected == id;
        }
    }

    private static IEnumerable<(string Id, string Name)> InstalledCustomPets()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var root = Path.Combine(home, ".tokentracker", "pets");
        var legacyRoot = Path.Combine(home, ".codex", "pets");
        var migrationComplete = File.Exists(Path.Combine(root, ".migrated-v1"));
        // The tray can build its menu before the embedded Node server migrates
        // legacy packages. Keep a read-only fallback until Node writes the marker.
        var roots = migrationComplete ? new[] { root } : new[] { root, legacyRoot };
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var sourceRoot in roots)
        {
            if (!Directory.Exists(sourceRoot)) continue;
            foreach (var directory in Directory.EnumerateDirectories(sourceRoot))
            {
                var id = Path.GetFileName(directory).ToLowerInvariant();
                if (seen.Contains(id) || PetWindow.NormalizeCharacter(id) != id || id is PetWindow.CharacterClawd or PetWindow.CharacterBot or PetWindow.CharacterSprout or PetWindow.CharacterByte or PetWindow.CharacterEmber) continue;
                var manifestPath = Path.Combine(directory, "pet.json");
                var spritesheetPath = Path.Combine(directory, "spritesheet.webp");
                if (!File.Exists(manifestPath) || !File.Exists(spritesheetPath)) continue;
                string name = id;
                try
                {
                    var manifest = JsonNode.Parse(File.ReadAllText(manifestPath))?.AsObject();
                    if (manifest?["id"]?.GetValue<string>()?.ToLowerInvariant() != id) continue;
                    name = manifest?["displayName"]?.GetValue<string>()?.Trim() is { Length: > 0 } displayName
                        ? displayName
                        : id;
                }
                catch { continue; }
                seen.Add(id);
                yield return (id, name);
            }
        }
    }

    private void RebuildCustomPetMenus()
    {
        _petCharacterSprout.Visible = !PetWindow.IsBuiltinCharacterHidden(PetWindow.CharacterSprout);
        _petCharacterByte.Visible = !PetWindow.IsBuiltinCharacterHidden(PetWindow.CharacterByte);
        _petCharacterEmber.Visible = !PetWindow.IsBuiltinCharacterHidden(PetWindow.CharacterEmber);
        _petCtxCharacterSprout.Visible = _petCharacterSprout.Visible;
        _petCtxCharacterByte.Visible = _petCharacterByte.Visible;
        _petCtxCharacterEmber.Visible = _petCharacterEmber.Visible;

        static void RemoveCustom(ToolStripItemCollection items)
        {
            foreach (var item in items.Cast<ToolStripItem>().Where(item => item.Tag is string).ToArray())
                items.Remove(item);
        }
        RemoveCustom(_petCharacterItem.DropDownItems);
        RemoveCustom(_petCtxCharacterItem.DropDownItems);
        foreach (var (id, name) in InstalledCustomPets().OrderBy(pet => pet.Name, StringComparer.CurrentCultureIgnoreCase))
        {
            var trayItem = CreateMenuItem(name, (_, _) => SetPetCharacter(id));
            trayItem.Tag = id;
            _petCharacterItem.DropDownItems.Add(trayItem);
            var contextItem = CreateMenuItem(name, (_, _) => SetPetCharacter(id));
            contextItem.Tag = id;
            _petCtxCharacterItem.DropDownItems.Add(contextItem);
        }
        StyleSubmenu(_petCharacterItem.DropDown);
        StyleSubmenu(_petCtxCharacterItem.DropDown);
    }

    /// <summary>True while the dashboard window is shown (not hidden / minimized).</summary>
    private bool IsDashboardOpen()
        => _dashboard is not null
           && _dashboard.IsVisible
           && _dashboard.WindowState != System.Windows.WindowState.Minimized;

    /// <summary>Flip the pet menu's first item between "Open" and "Close Dashboard".</summary>
    private void UpdatePetDashboardItem()
        => _petCtxOpen.Text = IsDashboardOpen() ? _strings.CloseDashboard : _strings.OpenDashboard;

    /// <summary>Show the pet's right-click context menu at the cursor.</summary>
    private void ShowPetContextMenu()
    {
        UpdatePetMenuText();
        UpdatePetDashboardItem();
        UpdatePetSizeChecks();
        UpdatePetCharacterChecks();
        _petMenu.Show(System.Windows.Forms.Cursor.Position);
    }

    /// <summary>Hide the floating pet (from its context menu) and remember it's closed.</summary>
    private void ClosePet()
    {
        if (_petWindow is null) return;
        _petWindow.HidePet();
        _petWindow.StoreVisible(false);
        _poller.IncludeRichStats = false;   // stop gathering the pet-only stats
        _poller.IncludeLimits = false;
        UpdatePetMenuText();
        PushDashboardPetSettings();
    }

    private void EnsureDashboard()
    {
        if (_dashboard is not null) return;
        var dashboard = new DashboardWindow(_server);
        _dashboard = dashboard;
        dashboard.ReleasedForIdle += OnDashboardReleasedForIdle;
        // Re-render the cost when the dashboard reports a currency change (and once
        // it has loaded, so we pick up the user's chosen currency right away), and cache
        // it natively so a future cold-launched pet shows the same unit before the
        // dashboard exists. CurrencyChanged only fires once the page is loaded, so the
        // read here is real (never the transient USD default).
        _dashboard.CurrencyChanged += () => PostToUi(() => { RefreshSummary(); PersistCurrencyFromDashboard(); });
        _dashboard.LocaleChanged += () => PostToUi(RefreshLocaleFromDashboard);
        _dashboard.ThemeChanged += () => PostToUi(RefreshThemeFromDashboard);
        _dashboard.PetSettingsRequested += () => PostToUi(PushDashboardPetSettings);
        _dashboard.PetSettingChanged += (key, value) => PostToUi(() => ApplyDashboardPetSetting(key, value));
        _dashboard.NativeSettingsRequested += () => PostToUi(PushDashboardNativeSettings);
        _dashboard.NativeSettingChanged += (key, value) => PostToUi(() => ApplyDashboardNativeSetting(key, value));
        _dashboard.NativeActionRequested += name => PostToUi(() => RunDashboardNativeAction(name));
        _dashboard.NotificationRequested += (title, body) => PostToUi(() =>
            _trayIcon.ShowBalloonTip(7000, title, body, ToolTipIcon.Warning));
    }

    private void OnDashboardReleasedForIdle(DashboardWindow dashboard)
    {
        if (!ReferenceEquals(_dashboard, dashboard)) return;
        dashboard.ReleasedForIdle -= OnDashboardReleasedForIdle;
        _dashboard = null;
    }

    private void ApplyDashboardPetSetting(string key, string? value)
    {
        switch (key)
        {
            case "visible":
                EnsurePet();
                if (string.Equals(value, "true", StringComparison.OrdinalIgnoreCase))
                {
                    _petWindow!.ShowPet();
                    _petWindow.StoreVisible(true);
                    _poller.IncludeRichStats = true;
                    _poller.IncludeLimits = true;
                    _poller.RefreshNow();
                }
                else
                {
                    _petWindow!.HidePet();
                    _petWindow.StoreVisible(false);
                    _poller.IncludeRichStats = false;
                    _poller.IncludeLimits = false;
                }
                UpdatePetMenuText();
                // Echo the applied state back; the size/character cases push inside
                // SetPetSize / SetPetCharacter already, so no unconditional re-push.
                PushDashboardPetSettings();
                break;
            case "size":
                SetPetSize(value ?? PetWindow.SizeMedium);
                break;
            case "character":
                SetPetCharacter(value ?? PetWindow.CharacterClawd);
                break;
            case "botColor":
                SetPetBotColor(value ?? "auto");
                break;
        }
    }

    private void SetPetBotColor(string colorId)
    {
        if (_petWindow is not null) _petWindow.ApplyBotColor(colorId);
        else PetWindow.PersistBotColor(colorId);
        PushDashboardPetSettings();
    }

    private void PushDashboardPetSettings()
    {
        _dashboard?.PushPetSettings(
            _petWindow?.IsVisible == true,
            PetWindow.CurrentSize,
            PetWindow.CurrentCharacter,
            PetWindow.CurrentBotColor);
    }

    /// <summary>Send the Windows-native settings consumed by the dashboard.</summary>
    private void PushDashboardNativeSettings()
    {
        if (_dashboard is null) return;

        string? updateStatus = _updateChecker.State switch
        {
            UpdateChecker.UpdateState.Checking => _updateStrings.Checking,
            UpdateChecker.UpdateState.UpdateAvailable => string.Format(
                _updateStrings.UpdateNow, _updateChecker.LatestVersion ?? ""),
            UpdateChecker.UpdateState.Downloading => string.Format(
                _updateStrings.Downloading, _updateChecker.ProgressPercent),
            UpdateChecker.UpdateState.Installing => _updateStrings.Installing,
            _ => null,
        };

        _dashboard.PushNativeSettings(new
        {
            platform = "windows",
            autoUpdateEnabled = _updateChecker.AutoUpdateEnabled,
            launchAtLogin = LaunchAtStartup.IsEnabled,
            // Startup can still be toggled from the tray menu; keep the
            // macOS-specific settings row out of the Windows page.
            launchAtLoginSupported = false,
            updateStatus,
            updateBusy = _updateChecker.State is UpdateChecker.UpdateState.Checking
                or UpdateChecker.UpdateState.Downloading
                or UpdateChecker.UpdateState.Installing,
            isSyncing = _isSyncing,
            version = _updateChecker.CurrentVersion,
            // These capabilities are macOS-only. Omitting their controls keeps the
            // Windows settings page focused on features that are actually supported.
            dynamicIslandSupported = false,
            widgetsSupported = false,
        });
    }

    private void ApplyDashboardNativeSetting(string key, object? value)
    {
        switch (key)
        {
            case "autoUpdateEnabled" when value is bool enabled:
                _updateChecker.AutoUpdateEnabled = enabled;
                break;
            case "launchAtLogin" when value is bool launch:
                if (launch) LaunchAtStartup.Enable();
                else LaunchAtStartup.Disable();
                break;
            default:
                return;
        }
        PushDashboardNativeSettings();
    }

    private void RunDashboardNativeAction(string name)
    {
        switch (name)
        {
            case "syncNow":
                _server.TriggerSync();
                break;
            case "checkForUpdates":
                OnCheckUpdatesClicked();
                break;
            case "openAbout":
                OpenInBrowser(Constants.GitHubUrl);
                break;
        }
    }

    /// <summary>
    /// Handle a <c>tokentracker://</c> deep link (forwarded from a second launch, or a
    /// cold start argument). Currently only the OAuth callback
    /// <c>tokentracker://auth/callback?insforge_code=…</c> is used; the code is routed
    /// into the dashboard WebView to finish the InsForge session exchange. Mirrors the
    /// macOS <c>application(_:open:)</c> → <c>handleAuthCallback</c> path.
    /// </summary>
    public void HandleDeepLink(string url)
    {
        DiagLog($"HandleDeepLink url={url}");
        string? code = null;
        try
        {
            var uri = new Uri(url);
            if (!uri.Host.Equals("auth", StringComparison.OrdinalIgnoreCase)) return;
            foreach (var pair in uri.Query.TrimStart('?').Split('&'))
            {
                var i = pair.IndexOf('=');
                if (i <= 0 || pair[..i] != "insforge_code") continue;
                var raw = pair[(i + 1)..];
                if (raw.Length > 0) code = Uri.UnescapeDataString(raw);
                break;
            }
        }
        catch { return; }

        if (string.IsNullOrEmpty(code)) { DiagLog("HandleDeepLink no insforge_code in query"); return; }
        var resolved = code;
        DiagLog($"HandleDeepLink resolved code.len={resolved.Length}");
        PostToUi(() =>
        {
            EnsureDashboard();
            _dashboard!.HandleAuthCallback(resolved);
        });
    }

    /// <summary>Diagnostics → %LOCALAPPDATA%\TokenTracker\windows-host.log (shared with ServerManager).</summary>
    private static void DiagLog(string message) => Diag.Log("tray", message);

    private void OnToggleStartup(object? sender, EventArgs e)
    {
        LaunchAtStartup.Toggle();
        _startupItem.Checked = LaunchAtStartup.IsEnabled;
    }

    /// <summary>
    /// Tray "Check for Updates" / "Update to vX". When a prior (silent) check already
    /// found a version, the item IS the update action — go straight to download+install.
    /// Otherwise run a manual check and report the outcome via a dialog.
    /// </summary>
    private void OnCheckUpdatesClicked()
    {
        switch (_updateChecker.State)
        {
            case UpdateChecker.UpdateState.UpdateAvailable:
                _ = _updateChecker.DownloadAndInstallAsync();
                break;
            case UpdateChecker.UpdateState.Idle:
                _ = RunManualCheckAsync();
                break;
            // Checking / Downloading / Installing: already busy — ignore the click.
        }
    }

    private async Task RunManualCheckAsync()
    {
        var outcome = await _updateChecker.CheckAsync(silent: false);
        switch (outcome)
        {
            case UpdateChecker.CheckOutcome.UpdateAvailable:
                var confirm = MessageBox.Show(
                    string.Format(_updateStrings.UpdateFoundPrompt, _updateChecker.LatestVersion, _updateChecker.CurrentVersion),
                    _updateStrings.UpdateFoundTitle,
                    MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (confirm == DialogResult.Yes) _ = _updateChecker.DownloadAndInstallAsync();
                break;
            case UpdateChecker.CheckOutcome.UpToDate:
                MessageBox.Show(
                    string.Format(_updateStrings.UpToDateMessage, _updateChecker.CurrentVersion),
                    _updateStrings.UpToDateTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                break;
            case UpdateChecker.CheckOutcome.Failed:
                MessageBox.Show(
                    _updateStrings.ErrorMessage, _updateStrings.ErrorTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                break;
            // Skipped: nothing to report.
        }
    }

    /// <summary>Reflect the checker's state in the menu item label + enabled state, and
    /// fire a one-time balloon when a background check surfaces a new version.</summary>
    private void RefreshUpdateMenuItem()
    {
        switch (_updateChecker.State)
        {
            case UpdateChecker.UpdateState.Checking:
                _checkUpdatesItem.Text = _updateStrings.Checking;
                _checkUpdatesItem.Enabled = false;
                break;
            case UpdateChecker.UpdateState.UpdateAvailable:
                _checkUpdatesItem.Text = string.Format(_updateStrings.UpdateNow, _updateChecker.LatestVersion);
                _checkUpdatesItem.Enabled = true;
                if (_updateChecker.AutoUpdateEnabled && _updateChecker.State == UpdateChecker.UpdateState.UpdateAvailable)
                {
                    // An enabled automatic check will immediately start the
                    // background installer, so a "click the tray to update"
                    // balloon would be both noisy and misleading.
                    break;
                }
                if (!_updateBalloonShown)
                {
                    _updateBalloonShown = true;
                    _trayIcon.ShowBalloonTip(5000, Constants.AppDisplayName,
                        string.Format(_updateStrings.NewVersionBalloon, _updateChecker.LatestVersion),
                        ToolTipIcon.Info);
                }
                break;
            case UpdateChecker.UpdateState.Downloading:
                _checkUpdatesItem.Text = string.Format(_updateStrings.Downloading, _updateChecker.ProgressPercent);
                _checkUpdatesItem.Enabled = false;
                break;
            case UpdateChecker.UpdateState.Installing:
                _checkUpdatesItem.Text = _updateStrings.Installing;
                _checkUpdatesItem.Enabled = false;
                break;
            default: // Idle
                _checkUpdatesItem.Text = _updateStrings.CheckForUpdates;
                _checkUpdatesItem.Enabled = true;
                break;
        }
        _checkUpdatesItem.ForeColor = _checkUpdatesItem.Enabled ? _menuPalette.Text : _menuPalette.DisabledText;
    }

    private void OnServerStatusChanged(ServerManager.ServerStatus status)
    {
        PostToUi(() =>
        {
            _petWindow?.ApplyConnected(status == ServerManager.ServerStatus.Running);
            if (status == ServerManager.ServerStatus.Running)
            {
                _poller.Start();   // begin (or resume) polling once the server answers
                _poller.RefreshNow();
                _syncTimer.Start();
                TriggerBackgroundSync();
            }
            else if (status == ServerManager.ServerStatus.Failed)
            {
                _syncTimer.Stop();
                var message = _server.LastError ?? "The local server stopped responding.";
                _trayIcon.ShowBalloonTip(5000, Constants.AppDisplayName, message, ToolTipIcon.Warning);
            }
        });
    }

    private void TriggerBackgroundSync()
    {
        if (_server.Status != ServerManager.ServerStatus.Running) return;
        _server.TriggerBackgroundSync();
    }

    private void OnSyncStarted()
    {
        _isSyncing = true;
        PostToUi(() =>
        {
            _petWindow?.ApplySyncing(true);
            PushDashboardNativeSettings();
        });
    }

    private void OnSyncCompleted()
    {
        _isSyncing = false;
        _poller.RefreshNow();
        PostToUi(() =>
        {
            _petWindow?.ApplySyncing(false);
            PushDashboardNativeSettings();
        });
    }

    private void OnStatsUpdated(UsagePoller.UsageStats stats)
    {
        _lastStats = stats;
        PostToUi(RefreshSummary);
    }

    private void OnLimitsUpdated(string limitsJson)
    {
        // The JSON is parsed and safely re-serialized by PetWindow before it is
        // sent into WebView2; this callback only crosses the thread boundary.
        PostToUi(() =>
        {
            _lastLimitsJson = limitsJson;
            _petWindow?.ApplyLimits(limitsJson);
        });
    }

    /// <summary>Render the today summary into the menu + tooltip, in the user's currency.</summary>
    private async void RefreshSummary()
    {
        // Convert USD → the dashboard's chosen currency. Reading the currency is a
        // WebView2 ExecuteScript round-trip — the 2s _refreshTimer would otherwise
        // poke the WebView forever, even while the window is hidden. Currency
        // changes originate in the (visible) dashboard and already arrive via
        // CurrencyChanged → persisted, so a hidden window can safely serve the
        // natively-cached symbol/rate (which also covers a cold-launched pet).
        var (symbol, rate) = IsDashboardOpen()
            ? await _dashboard!.ReadCurrencyAsync()
            : Currency.ReadPersisted() ?? ("$", 1m);
        // Push currency + language to the pet even before the first usage poll lands, so
        // a freshly launched pet never sits in default USD/English until polling finishes
        // (connection state is owned by OnServerStatusChanged).
        _petWindow?.ApplyCurrency(symbol, rate);
        _petWindow?.ApplyLocale(NativeLocalization.ResolveLocale(_localePreference));
        _petWindow?.ApplyLimits(_lastLimitsJson);

        if (_lastStats is not { } s)
        {
            _petWindow?.ApplyStats(default);
            _summaryItem.Text = $"{_strings.TodayTitle}: {_strings.NoData}";
            return;
        }

        // Feed the floating pet the SAME numbers the tray shows (same poller, same moment).
        _petWindow?.ApplyStats(s);
        _petWindow?.ApplyConnected(_server.Status == ServerManager.ServerStatus.Running);
        var cost = symbol + (s.TodayCostUsd * rate).ToString("0.00", CultureInfo.InvariantCulture);
        var text = s.TodayTokens <= 0
            ? $"{_strings.TodayTitle}: {_strings.NoData}"
            : $"{_strings.TodayTitle}: {UsagePoller.FormatTokens(s.TodayTokens)} {_strings.TokensUnit} · {cost}";

        _summaryItem.Text = text;
        // The tray-icon tooltip stays the app name (set once in the ctor). The floating
        // pet now surfaces live usage, so the hover tooltip no longer mirrors the summary.
        RefreshTrayIconForTheme();
    }

    /// <summary>Cache the dashboard's current currency natively so a cold-launched pet
    /// (no dashboard WebView yet) can show the right unit. Only called from the
    /// CurrencyChanged handler, where the read reflects a real, loaded value.</summary>
    private async void PersistCurrencyFromDashboard()
    {
        if (_dashboard is null) return;
        var (symbol, rate) = await _dashboard.ReadCurrencyAsync();
        Currency.Persist(symbol, rate);
    }

    private void PostToUi(Action action)
    {
        if (_uiDispatcher.HasShutdownStarted || _uiDispatcher.HasShutdownFinished) return;
        if (_uiDispatcher.CheckAccess())
        {
            action();
            return;
        }
        _uiDispatcher.BeginInvoke(action);
    }

    private static void OpenInBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { /* ignore */ }
    }

    // ── Tray icon (Clawd mascot, themed to the taskbar) ────────────────

    private bool? _lastIconLight;

    private Icon LoadTrayIcon()
    {
        _lastIconLight = IsTaskbarLight();
        return LoadMascotIcon(_lastIconLight.Value) ?? SystemIcons.Application;
    }

    /// <summary>Swap the mascot glyph if the taskbar light/dark theme changed.</summary>
    private void RefreshTrayIconForTheme()
    {
        bool light = IsTaskbarLight();
        if (_lastIconLight == light) return;
        var icon = LoadMascotIcon(light);
        if (icon is null) return;
        _lastIconLight = light;
        var old = _trayIcon.Icon;
        _trayIcon.Icon = icon;
        old?.Dispose();
    }

    private static Icon? LoadMascotIcon(bool taskbarLight)
    {
        // Light taskbar → dark glyph; dark taskbar → white glyph.
        var file = taskbarLight ? "tray-mascot-onLight.ico" : "tray-mascot-onDark.ico";
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "assets", file);
            if (File.Exists(path)) return new Icon(path);
        }
        catch { /* fall through */ }
        return null;
    }

    private static bool IsTaskbarLight()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            // SystemUsesLightTheme governs the taskbar/tray; 1 = light, 0/absent = dark.
            return (key?.GetValue("SystemUsesLightTheme") as int?) == 1;
        }
        catch
        {
            return false; // assume dark taskbar (Win11 default)
        }
    }

    private void Quit()
    {
        _refreshTimer.Stop();
        _syncTimer.Stop();
        _trayIcon.Visible = false;
        _poller.Dispose();
        _server.StopServer();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _refreshTimer.Dispose();
            _syncTimer.Dispose();
            _poller.Dispose();
            _server.Dispose();
            _trayIcon.Dispose();
            _menu.Dispose();
            _petMenu.Dispose();
            _menuFont?.Dispose();
            _summaryFont?.Dispose();
            _dashboard?.Shutdown();   // WPF Window has no Dispose; really close it
            _petWindow?.Shutdown();
        }
        base.Dispose(disposing);
    }
}
