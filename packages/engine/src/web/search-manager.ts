/**
 * The Search Manager — one door in front of every search backend.
 *
 * Nothing above this file knows which backend answered. Tavily, DuckDuckGo,
 * a self-hosted SearXNG, a key-holding Brave account, a crawler of our own:
 * each is a `SearchProvider`, and adding one is one new object in the list.
 *
 * ── What "no scary error" means here ───────────────────────────────────────
 * The manager's job is to make a backend's failure invisible whenever
 * another backend can cover for it:
 *
 *   - a provider with no key is skipped, silently, every time — being
 *     unconfigured is a normal state, not something to nag about;
 *   - a provider that reports its quota is spent is skipped for a while, so
 *     the *next* search does not pay for a request that is going to fail;
 *   - a provider that errors is skipped for that one search and the next
 *     provider is tried.
 *
 * Only when every provider is unavailable or failed does the caller hear
 * about it, and even then as a structured outcome, not an exception.
 */

import type { SearchFailureKind, WebSearchOptions, WebSearchResult } from '@atlas/core';

export interface SearchProvider {
  /** Stable id, stamped onto every result this provider returns. */
  id: string;
  /** What a person would call it, for the activity panel. */
  label: string;
  /** False when it cannot run at all right now (no key saved). Cheap; called per search. */
  isAvailable(): Promise<boolean>;
  /** Throws `SearchError` on refusal so the manager can tell a spent quota from a bad key. */
  search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]>;
}

export class SearchError extends Error {
  constructor(
    public readonly kind: SearchFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

export type AttemptOutcome = 'ok' | 'empty' | 'unavailable' | 'cooling-down' | SearchFailureKind;

export interface SearchAttempt {
  provider: string;
  label: string;
  outcome: AttemptOutcome;
}

export type SearchOutcome =
  | {
      ok: true;
      results: WebSearchResult[];
      provider: string;
      providerLabel: string;
      attempts: SearchAttempt[];
    }
  | {
      ok: false;
      /** `none-available`: nothing to try. `all-failed`: something was tried and none answered. */
      reason: 'none-available' | 'all-failed';
      attempts: SearchAttempt[];
    };

/** How long to leave a provider alone after each kind of refusal. */
export const COOLDOWN_MS: Record<SearchFailureKind, number> = {
  quota: 30 * 60_000, // an allowance does not refill in minutes; do not pay for a doomed request each time
  auth: 5 * 60_000, // long enough to stop hammering, short enough that a corrected key is picked up soon
  rate: 60_000,
  blocked: 5 * 60_000, // a CAPTCHA does not clear by asking again
  offline: 0, // the network coming back is not something to wait out
  error: 0,
};

export class SearchManager {
  private readonly coolUntil = new Map<string, number>();

  constructor(
    private readonly providers: SearchProvider[],
    private readonly now: () => number = Date.now,
  ) {}

  /** Provider ids in the order they are tried. */
  order(): string[] {
    return this.providers.map((p) => p.id);
  }

  /** Forget every cooldown — for when the user has just changed a key. */
  reset(): void {
    this.coolUntil.clear();
  }

  async search(query: string, options: WebSearchOptions = {}): Promise<SearchOutcome> {
    const attempts: SearchAttempt[] = [];
    let emptyFrom: SearchProvider | null = null;

    for (const provider of this.providers) {
      const base = { provider: provider.id, label: provider.label };

      if ((this.coolUntil.get(provider.id) ?? 0) > this.now()) {
        attempts.push({ ...base, outcome: 'cooling-down' });
        continue;
      }

      let available = false;
      try {
        available = await provider.isAvailable();
      } catch {
        available = false;
      }
      if (!available) {
        attempts.push({ ...base, outcome: 'unavailable' });
        continue;
      }

      try {
        const found = await provider.search(query, options);
        if (!found.length) {
          // Nothing is not a failure, but another backend might know better.
          attempts.push({ ...base, outcome: 'empty' });
          emptyFrom ??= provider;
          continue;
        }
        attempts.push({ ...base, outcome: 'ok' });
        return {
          ok: true,
          results: found.map((r) => ({ ...r, provider: provider.id })),
          provider: provider.id,
          providerLabel: provider.label,
          attempts,
        };
      } catch (e) {
        const kind: SearchFailureKind = e instanceof SearchError ? e.kind : 'error';
        const wait = COOLDOWN_MS[kind];
        if (wait > 0) this.coolUntil.set(provider.id, this.now() + wait);
        attempts.push({ ...base, outcome: kind });
      }
    }

    if (emptyFrom) {
      // Somebody answered, and the honest answer was "nothing found".
      return {
        ok: true,
        results: [],
        provider: emptyFrom.id,
        providerLabel: emptyFrom.label,
        attempts,
      };
    }
    const triedAny = attempts.some(
      (a) => a.outcome !== 'unavailable' && a.outcome !== 'cooling-down',
    );
    return { ok: false, reason: triedAny ? 'all-failed' : 'none-available', attempts };
  }
}
