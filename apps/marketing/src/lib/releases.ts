// FILE: releases.ts
// Purpose: Fetches the latest Synara Beta release and maps its assets to a
//          per-platform download map (macOS arm64/x64, Windows, Linux) for the
//          /install page.
// Layer: Server utility
// Depends on: GitHub Releases API, optional GITHUB_TOKEN
// Note: Beta releases are GitHub prereleases, which `/releases/latest` never
//       returns — the page lists releases and picks the newest
//       `vX.Y.Z-beta.N` tag instead.

import "server-only";

const REPO = "kartikkabadi/synara-beta";
const BETA_TAG_PATTERN = /^v\d+\.\d+\.\d+-beta\.\d+$/u;
const RELEASES_LIST_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

export type ReleaseDownloads = {
  // Tag for the latest release (e.g. "v0.1.0"), or null when unknown.
  version: string | null;
  // Page that lists every asset — used as the universal fallback target.
  releasesUrl: string;
  mac: { arm64: string; x64: string };
  windows: string;
  linux: { x64: string; arm64: string };
};

type GitHubReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
  assets?: GitHubReleaseAsset[];
};

// Last-resort fallback: the public release listing is better than a broken href.
const FALLBACK: ReleaseDownloads = {
  version: null,
  releasesUrl: RELEASES_URL,
  mac: { arm64: RELEASES_URL, x64: RELEASES_URL },
  windows: RELEASES_URL,
  linux: { x64: RELEASES_URL, arm64: RELEASES_URL },
};

function getFallbackDownloads(): ReleaseDownloads {
  // Until the first beta release ships there is no beta snapshot to fall back
  // to; the release listing page is the honest fallback (direct asset links
  // would point at the wrong channel).
  return FALLBACK;
}

export async function getReleaseDownloads(): Promise<ReleaseDownloads> {
  if (process.env.VISUAL_TEST === "1") return getFallbackDownloads();

  try {
    const headers: HeadersInit = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const response = await fetch(RELEASES_LIST_API_URL, {
      headers,
      // Release artifacts change rarely; cache for 30 minutes.
      next: { revalidate: 1800 },
    });

    if (!response.ok) return getFallbackDownloads();

    // SAFETY: the GitHub releases API returns a JSON array of release objects;
    // every field read below is guarded (tag_name/html_url/assets optional).
    const releases = (await response.json()) as GitHubRelease[];
    const release = releases.find((entry) => BETA_TAG_PATTERN.test(entry.tag_name ?? ""));
    if (!release) return getFallbackDownloads();
    const assets = release.assets ?? [];
    const releasesUrl = release.html_url ?? RELEASES_URL;

    // First asset whose name matches wins; fall back to the listing page.
    const urlFor = (pattern: RegExp): string =>
      assets.find((asset) => asset.name && pattern.test(asset.name))?.browser_download_url ??
      releasesUrl;

    return {
      version: release.tag_name ?? null,
      releasesUrl,
      mac: {
        arm64: urlFor(/arm64\.dmg$/i),
        x64: urlFor(/x64\.dmg$/i),
      },
      windows: urlFor(/\.exe$/i),
      linux: {
        x64: urlFor(/x64\.AppImage$/i),
        arm64: urlFor(/arm64\.AppImage$/i),
      },
    };
  } catch {
    return getFallbackDownloads();
  }
}
