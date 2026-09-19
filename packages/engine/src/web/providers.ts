/**
 * The concrete search providers, each a thin adapter from `Platform` to the
 * manager's `SearchProvider`. All the HTTP happens natively (`web.rs`); a
 * keyed backend's credential is read there too and never reaches this side.
 */

import type { Platform, SearchFailureKind, SearchProviderId, WebSearchResult } from '@atlas/core';
import { SearchError, SearchManager, type SearchProvider } from './search-manager';

const TAGGED = /^(quota|auth|rate|blocked|offline|error):\s*([\s\S]*)$/i;

/**
 * Turn whatever a platform call rejected with into a `SearchError`.
 *
 * The native side tags its refusals (`quota: …`). Older paths — the plain
 * DuckDuckGo command, a test double — do not, so a few phrases are
 * recognised too; anything else is a generic `error`, which the manager
 * treats as "skip this one for now" with no cooldown.
 */
export function classifySearchError(e: unknown): SearchError {
  if (e instanceof SearchError) return e;
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const tagged = TAGGED.exec(raw);
  if (tagged)
    return new SearchError(tagged[1]!.toLowerCase() as SearchFailureKind, tagged[2]!.trim());
  if (/confirm this isn'?t automated|challenge|captcha/i.test(raw)) {
    return new SearchError('blocked', raw);
  }
  if (/couldn'?t reach|connection|timed? ?out|network/i.test(raw)) {
    return new SearchError('offline', raw);
  }
  return new SearchError('error', raw || "The search didn't work.");
}

function viaPlatform(
  platform: Platform,
  id: SearchProviderId,
  label: string,
  ready: () => Promise<boolean>,
  legacy?: () => ((query: string) => Promise<WebSearchResult[]>) | undefined,
): SearchProvider {
  return {
    id,
    label,
    isAvailable: ready,
    async search(query, options) {
      try {
        if (platform.searchWebWith) return await platform.searchWebWith(id, query, options);
        const plain = legacy?.();
        if (plain) return await plain(query);
        return [];
      } catch (e) {
        throw classifySearchError(e);
      }
    },
  };
}

/** Needs a key saved on this machine. Absent key = unavailable, which is silent. */
export function tavilyProvider(platform: Platform): SearchProvider {
  return viaPlatform(platform, 'tavily', 'Tavily', async () => {
    if (!platform.searchWebWith || !platform.searchProviderReady) return false;
    return platform.searchProviderReady('tavily').catch(() => false);
  });
}

/** Needs nothing. Available whenever the platform can search at all. */
export function duckDuckGoProvider(platform: Platform): SearchProvider {
  return viaPlatform(
    platform,
    'duckduckgo',
    'DuckDuckGo',
    async () => Boolean(platform.searchWebWith || platform.searchWeb),
    () => platform.searchWeb?.bind(platform),
  );
}

/** Tavily first when a key exists, DuckDuckGo otherwise or when Tavily cannot answer. */
export function createSearchManager(
  platform: Platform,
  extra: SearchProvider[] = [],
): SearchManager {
  return new SearchManager([tavilyProvider(platform), duckDuckGoProvider(platform), ...extra]);
}
