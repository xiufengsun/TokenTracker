import React, { useMemo } from "react";
import { Download } from "lucide-react";
import { detectOS } from "../../../lib/os";
import { AppleIcon, GithubIcon, WindowsIcon } from "./icons.jsx";
import { MAC_DMG_URL, RELEASES_URL, REPO_URL, WIN_SETUP_URL } from "../../../lib/config";

/**
 * OS-detected primary download pill + secondary other-platform / GitHub links.
 * `githubLabel` is resolved by the caller (MarketingLanding) so the literal
 * copy("landing.cta.secondary") call stays in the file the repo tests pin.
 */
export function DownloadButtons({ copy, githubLabel }) {
  const os = useMemo(() => detectOS(), []);
  const macDownload = { href: MAC_DMG_URL, label: copy("landing.v2.install.os_macos"), Icon: AppleIcon };
  const winDownload = { href: WIN_SETUP_URL, label: copy("landing.v2.install.os_windows"), Icon: WindowsIcon };
  const nativeDownload =
    os === "windows"
      ? { href: WIN_SETUP_URL, label: copy("landing.v2.install.win_cta"), Icon: WindowsIcon }
      : os === "mac"
        ? { href: MAC_DMG_URL, label: copy("landing.v2.install.mac_cta"), Icon: AppleIcon }
        : { href: RELEASES_URL, label: copy("landing.v2.install.desktop_cta"), Icon: Download };
  const secondaryDownloads =
    os === "windows" ? [macDownload] : os === "mac" ? [winDownload] : [macDownload, winDownload];

  const secondaryLinks = [
    ...secondaryDownloads.map((d) => ({ key: d.href, href: d.href, Icon: d.Icon, label: d.label })),
    { key: REPO_URL, href: REPO_URL, Icon: GithubIcon, label: githubLabel },
  ];

  return (
    <div className="flex justify-center">
      {/* The primary pill sets the column width; the secondary pills split it
          exactly, so the whole group reads as one aligned block. */}
      <div className="flex min-w-[16rem] flex-col items-stretch">
        <a
          href={nativeDownload.href}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-7 text-sm font-semibold text-oai-gray-950 shadow-lg shadow-black/30 transition-all duration-200 ease-out hover:bg-oai-gray-100 motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] motion-reduce:transition-none"
        >
          <nativeDownload.Icon className="h-4 w-4" />
          {nativeDownload.label}
        </a>
        <div className="mt-3 flex gap-3">
          {secondaryLinks.map((link) => (
            <a
              key={link.key}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-full border border-white/10 bg-oai-black/60 px-3 text-sm font-medium text-oai-gray-200 backdrop-blur-sm transition-all duration-200 ease-out hover:border-white/25 hover:text-white motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] motion-reduce:transition-none"
            >
              <link.Icon className="h-4 w-4 shrink-0 text-oai-gray-400 group-hover:text-white" />
              <span className="truncate">{link.label}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
