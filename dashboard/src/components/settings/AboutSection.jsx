import React, { useEffect, useState } from "react";
import { ExternalLink, Globe, Scale } from "lucide-react";
import { copy } from "../../lib/copy";
import { SectionCard, SettingsRow } from "./Controls.jsx";

const GITHUB_REPO = "xiufengsun/TokenTracker";
const REPO_URL = `https://github.com/${GITHUB_REPO}`;
const PROJECT_URL = "https://www.tokentracker.cc";
const CONTRIBUTORS_ENDPOINT = `https://api.github.com/repos/${GITHUB_REPO}/contributors?per_page=100`;

/**
 * About the project: what Token Tracker is, where it lives, and the people
 * who build it. Static information only — the contributors fall back to a
 * plain GitHub link. Sections stay mounted while hidden, so the GitHub
 * request is gated on `active` to keep other Settings pages from firing it.
 */
export function AboutSection({ active = true } = {}) {
  const version = import.meta.env.VITE_APP_VERSION;
  return (
    <div className="space-y-4">
      <SectionCard title={copy("settings.section.about")}>
        <div className="py-3">
          <p className="text-sm leading-6 text-oai-gray-700 dark:text-oai-gray-300">
            {copy("settings.about.intro.body")}
          </p>
        </div>
        <SettingsRow
          label={copy("settings.about.intro.version")}
          control={
            <span className="text-sm font-medium tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
              {version}
            </span>
          }
        />
        <SettingsRow
          label={copy("settings.about.intro.license")}
          control={
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">
              <Scale className="h-3.5 w-3.5 text-oai-gray-400" aria-hidden />
              {copy("settings.about.intro.licenseMit")}
            </span>
          }
        />
        <SettingsRow
          label={copy("settings.about.intro.links")}
          control={
            <span className="flex items-center gap-4">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-oai-gray-600 underline-offset-2 transition-colors hover:text-oai-black hover:underline dark:text-oai-gray-400 dark:hover:text-white"
              >
                <GithubMark />
                {copy("settings.about.intro.github")}
              </a>
              <a
                href={PROJECT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-oai-gray-600 underline-offset-2 transition-colors hover:text-oai-black hover:underline dark:text-oai-gray-400 dark:hover:text-white"
              >
                <Globe className="h-3.5 w-3.5 text-oai-gray-400" aria-hidden />
                {copy("settings.about.intro.website")}
              </a>
            </span>
          }
        />
      </SectionCard>
      <ContributorsCard active={active} />
    </div>
  );
}

function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-oai-gray-400" aria-hidden>
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

const IDLE = { status: "idle" };

function useContributors(active) {
  const [state, setState] = useState(IDLE);
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    let cancelled = false;
    setState({ status: "loading" });
    fetch(CONTRIBUTORS_ENDPOINT, { headers: { Accept: "application/vnd.github+json" } })
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error(`GitHub API ${response.status}`)),
      )
      .then((entries) => {
        if (cancelled || !Array.isArray(entries)) return;
        const contributors = entries
          .filter((entry) => entry && typeof entry.login === "string" && entry.type !== "Bot")
          .map((entry) => ({
            login: entry.login,
            profileUrl: entry.html_url,
            avatarUrl: entry.avatar_url,
            contributions: typeof entry.contributions === "number" ? entry.contributions : 0,
          }));
        if (!cancelled) setState({ status: "ready", contributors });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return state;
}

function ContributorsCard({ active }) {
  const { status, contributors } = useContributors(active);
  return (
    <SectionCard
      title={copy("settings.about.contributors.title")}
      subtitle={copy("settings.about.contributors.subtitle")}
      action={
        <a
          href={`${REPO_URL}/graphs/contributors`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-oai-gray-500 underline-offset-2 transition-colors hover:text-oai-black hover:underline dark:text-oai-gray-400 dark:hover:text-white"
        >
          {copy("settings.about.contributors.viewAll")}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      }
    >
      {status === "loading" || status === "idle" ? (
        <p role="status" className="py-3 text-sm text-oai-gray-500 dark:text-oai-gray-400">
          {copy("settings.about.contributors.loading")}
        </p>
      ) : null}
      {status === "error" ? (
        <p role="alert" className="py-3 text-sm text-oai-gray-500 dark:text-oai-gray-400">
          {copy("settings.about.contributors.error")}
        </p>
      ) : null}
      {status === "ready" && contributors.length === 0 ? (
        <p className="py-3 text-sm text-oai-gray-500 dark:text-oai-gray-400">
          {copy("settings.about.contributors.error")}
        </p>
      ) : null}
      {status === "ready" && contributors.length > 0 ? (
        <ul className="flex flex-wrap gap-2 py-3">
          {contributors.map((contributor) => (
            <li key={contributor.login}>
              <a
                href={contributor.profileUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={copy("settings.about.contributors.itemTitle", {
                  contributor: contributor.login,
                  contributions: contributor.contributions,
                })}
                className="inline-flex max-w-full items-center gap-2 rounded-full border border-oai-gray-200 bg-oai-gray-50 py-1 pl-1 pr-3 transition-colors hover:border-oai-gray-300 hover:bg-oai-gray-100 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:hover:border-oai-gray-700 dark:hover:bg-oai-gray-800"
              >
                {contributor.avatarUrl ? (
                  <img
                    src={contributor.avatarUrl}
                    alt=""
                    loading="lazy"
                    className="h-6 w-6 shrink-0 rounded-full"
                  />
                ) : null}
                <span className="truncate text-xs font-medium text-oai-gray-700 dark:text-oai-gray-300">
                  {contributor.login}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
                  {contributor.contributions}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </SectionCard>
  );
}
