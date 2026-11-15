using Xunit;

namespace TokenTrackerWin;

public sealed class UpdateCheckerSilentInstallTests
{
    [Fact]
    public void SilentInstallerArgumentsRelaunchOnlyAfterASuccessfulInstall()
    {
        var arguments = UpdateChecker.BuildSilentInstallerArguments(
            @"C:\Users\user\AppData\Local\TokenTracker\updates\TokenTracker-Setup-1.5.19.exe",
            @"C:\Users\user\AppData\Local\Programs\TokenTracker\TokenTracker.exe");

        Assert.Contains("/VERYSILENT", arguments, StringComparison.Ordinal);
        Assert.Contains("/FORCECLOSEAPPLICATIONS", arguments, StringComparison.Ordinal);
        Assert.Contains("&& start \"\"", arguments, StringComparison.Ordinal);
        Assert.DoesNotMatch(@"[^&]& start ", arguments);
        Assert.Contains("--startup", arguments, StringComparison.Ordinal);
        Assert.StartsWith("/c ", arguments, StringComparison.Ordinal);
    }

    [Fact]
    public void SilentInstallerArgumentsQuoteTheSetupAndAppPaths()
    {
        var setup = @"C:\Program Files\TokenTracker\TokenTracker-Setup.exe";
        var app = @"C:\Program Files\TokenTracker\TokenTracker.exe";
        var arguments = UpdateChecker.BuildSilentInstallerArguments(setup, app);

        Assert.Contains($"\"{setup}\"", arguments, StringComparison.Ordinal);
        Assert.Contains($"\"{app}\" --startup", arguments, StringComparison.Ordinal);
    }
}
