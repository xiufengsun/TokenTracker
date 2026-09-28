using System;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace TokenTrackerWin;

/// <summary>
/// SHA-256 helpers for the updater's "don't execute what you didn't verify" gate.
///
/// The release workflow publishes a coreutils-style <c>SHA256SUMS</c> asset next to
/// the platform binaries, so the updater can prove the installer it is about to run
/// is byte-for-byte the one CI built. Deliberately free of HTTP, UI and Windows-only
/// APIs so <c>TokenTrackerWin.Tests</c> (net8.0) can exercise the parse/compare rules
/// directly — <see cref="UpdateChecker"/> itself needs WinForms and cannot be tested.
/// </summary>
internal static class UpdateIntegrity
{
    /// <summary>Name of the checksum asset the publish job attaches to every release it flips live.</summary>
    public const string ChecksumsAssetName = "SHA256SUMS";

    /// <summary>
    /// Pull one file's digest out of a <c>sha256sum</c>-format body:
    /// <c>&lt;64 hex&gt;&#160;&#160;&lt;name&gt;</c>, or <c>&lt;64 hex&gt; *&lt;name&gt;</c> in binary mode.
    /// Unknown lines, comments and blank lines are ignored.
    /// Returns <c>null</c> when the body carries no well-formed line for
    /// <paramref name="fileName"/> — callers must treat that as "no checksum
    /// published", never as "checksum mismatch".
    /// </summary>
    public static string? FindDigest(string? checksumsBody, string fileName)
    {
        if (string.IsNullOrWhiteSpace(checksumsBody) || string.IsNullOrWhiteSpace(fileName)) return null;

        foreach (var rawLine in checksumsBody.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line[0] == '#') continue;

            var separator = line.IndexOf(' ');
            if (separator <= 0) continue;

            var digest = line[..separator];
            if (!IsSha256Hex(digest)) continue;

            // Skip the padding and the binary-mode '*' marker before the name.
            var name = line[(separator + 1)..].TrimStart(' ', '*');
            if (name.Equals(fileName, StringComparison.OrdinalIgnoreCase))
                return digest.ToLowerInvariant();
        }

        return null;
    }

    /// <summary>64 lowercase-or-uppercase hex characters, nothing else.</summary>
    public static bool IsSha256Hex(string? value)
        => value is { Length: 64 } && value.All(Uri.IsHexDigit);

    /// <summary>Streaming SHA-256 of a file, as lowercase hex.</summary>
    public static async Task<string> ComputeSha256Async(string path, CancellationToken cancellationToken = default)
    {
        await using var stream = new FileStream(
            path, FileMode.Open, FileAccess.Read, FileShare.Read,
            bufferSize: 1024 * 64, useAsync: true);
        using var sha = SHA256.Create();
        var hash = await sha.ComputeHashAsync(stream, cancellationToken);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    /// <summary>Case-insensitive digest comparison (hex casing is not meaningful).</summary>
    public static bool Matches(string? expected, string? actual)
        => IsSha256Hex(expected)
           && string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase);
}
