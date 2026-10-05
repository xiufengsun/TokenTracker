using System.IO;
using Microsoft.Web.WebView2.Core;

namespace TokenTrackerWin;

/// <summary>Shares the pet/quota WebView2 profile and retries environment creation after failure.</summary>
internal sealed class WidgetWebViewEnvironment
{
    private readonly object _sync = new();
    private readonly string? _userDataFolderOverride;
    private Task<CoreWebView2Environment>? _environmentTask;

    public WidgetWebViewEnvironment(string? userDataFolderOverride = null)
    {
        _userDataFolderOverride = userDataFolderOverride;
    }

    public async Task<CoreWebView2Environment> GetAsync()
    {
        Task<CoreWebView2Environment> task;
        lock (_sync)
        {
            task = _environmentTask ??= CreateAsync();
        }

        try
        {
            return await task;
        }
        catch
        {
            lock (_sync)
            {
                if (ReferenceEquals(_environmentTask, task)) _environmentTask = null;
            }
            throw;
        }
    }

    private Task<CoreWebView2Environment> CreateAsync()
    {
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "TokenTracker", "WebView2Pet");
        if (_userDataFolderOverride is not null) userDataFolder = _userDataFolderOverride;
        Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0");
        return CoreWebView2Environment.CreateAsync(null, userDataFolder, null);
    }
}
