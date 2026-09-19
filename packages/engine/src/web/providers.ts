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
  prepare: (query: string) => string = (q) => q,
): SearchProvider {
  return {
    id,
    label,
    isAvailable: ready,
    async search(query, options) {
      const prepared = prepare(query);
      try {
        if (platform.searchWebWith) return await platform.searchWebWith(id, prepared, options);
        const plain = legacy?.();
        if (plain) return await plain(prepared);
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

const MONTH_YEAR =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d\d\b/gi;
const NOW_WORDS = /\b(?:current(?:ly)?|latest|newest|today|right now|now)\b/gi;

/**
 * What to ask an encyclopedia. The query rewriter adds "September 2026" and
 * "latest" so a news index prefers fresh pages; Wikipedia's search requires
 * every word to match, so those same words would return nothing. The subject
 * is what an article is titled after, so that is what is left.
 */
export function encyclopediaQuery(query: string): string {
  const stripped = query
    .replace(MONTH_YEAR, ' ')
    .replace(NOW_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length >= 3 ? stripped : query;
}

/**
 * Keyless, official-API knowledge. Last in line on purpose: it is an
 * encyclopedia, good for "what is X" and slow to learn what happened this
 * week, so it backs the others up rather than leading. An answer built from
 * it says so (see `verifyEvidence`).
 */
export function wikipediaProvider(platform: Platform): SearchProvider {
  return viaPlatform(
    platform,
    'wikipedia',
    'Wikipedia',
    async () => Boolean(platform.searchWebWith),
    undefined,
    encyclopediaQuery,
  );
}

/**
 * Tavily first when a key exists; DuckDuckGo when it does not or cannot
 * answer; Wikipedia when neither can. Nothing above the manager knows this
 * order.
 */
export function createSearchManager(
  platform: Platform,
  extra: SearchProvider[] = [],
): SearchManager {
  return new SearchManager([
    tavilyProvider(platform),
    duckDuckGoProvider(platform),
    wikipediaProvider(platform),
    ...extra,
  ]);
}
