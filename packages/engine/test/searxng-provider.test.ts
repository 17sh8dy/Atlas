/**
 * SearXNG inside the existing search manager: optional, first when set up, silent when not,
 * and always backed by the engines that were already there.
 */
import { describe, expect, test } from 'vitest';
import type { Platform, SearchProviderId, WebSearchResult } from '@atlas/core';
import { classifySearchError, createSearchManager, searxngProvider } from '../src/web/providers';
import { COOLDOWN_MS, SearchError } from '../src/web/search-manager';

type Behaviour = (query: string) => WebSearchResult[] | Error | Promise<WebSearchResult[]>;

function row(title: string, url: string, extra: Partial<WebSearchResult> = {}): WebSearchResult {
  return { title, url, snippet: `${title} snippet`, ...extra };
}

/** A platform whose backends are scripted, recording every call it receives. */
function rig(opts: { ready?: Partial<Record<SearchProviderId, boolean>>; backends?: Partial<Record<SearchProviderId, Behaviour>> }) {
  const calls: Array<{ provider: string; args: unknown[] }> = [];
  const ready = { searxng: false, tavily: false, duckduckgo: true, wikipedia: true, ...opts.ready };
  const platform = {
    searchProviderReady: async (p: SearchProviderId) => ready[p],
    searchWebWith: async (p: SearchProviderId, ...args: unknown[]) => {
      calls.push({ provider: p, args: [p, ...args] });
      const b = opts.backends?.[p];
      if (!b) return [];
      const out = await b(String(args[0]));
      if (out instanceof Error) throw out;
      return out;
    },
  } as unknown as Platform;
  let now = 1_000_000;
  const manager = createSearchManager(platform);
  // Deterministic cooldowns.
  (manager as unknown as { now: () => number }).now = () => now;
  return {
    manager,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    providers: () => calls.map((c) => c.provider),
  };
}

const SEARX_ROWS = [
  row('Rust', 'https://www.rust-lang.org/', { engines: ['duckduckgo', 'brave'], publishedDate: '2024-05-01' }),
  row('The Book', 'https://doc.rust-lang.org/book/'),
];

describe('when SearXNG is not set up', () => {
  test('it is skipped silently and the order is exactly what it always was', async () => {
    const r = rig({ backends: { duckduckgo: () => [row('DDG', 'https://ddg.example/')] } });
    const out = await r.manager.search('rust', {});
    expect(out.ok && out.provider).toBe('duckduckgo');
    expect(r.providers()).toEqual(['duckduckgo']);
    const searx = out.attempts.find((a) => a.provider === 'searxng');
    expect(searx?.outcome).toBe('unavailable');
  });

  test('nothing is ever sent to it', async () => {
    const r = rig({ backends: { searxng: () => SEARX_ROWS, duckduckgo: () => [row('DDG', 'https://ddg.example/')] } });
    await r.manager.search('anything private', {});
    expect(r.calls.some((c) => c.provider === 'searxng')).toBe(false);
  });
});

describe('when it is set up', () => {
  test('it answers first, and attribution and sources survive', async () => {
    const r = rig({ ready: { searxng: true, tavily: true }, backends: { searxng: () => SEARX_ROWS, tavily: () => [row('T', 'https://t.example/')] } });
    const out = await r.manager.search('rust', { topic: 'general' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.provider).toBe('searxng');
    expect(out.providerLabel).toBe('SearXNG');
    expect(out.results.map((x) => x.url)).toEqual(['https://www.rust-lang.org/', 'https://doc.rust-lang.org/book/']);
    expect(out.results[0]).toMatchObject({ provider: 'searxng', engines: ['duckduckgo', 'brave'], publishedDate: '2024-05-01' });
    // Tavily was never consulted: it did not have to be.
    expect(r.providers()).toEqual(['searxng']);
  });

  test('the search call carries only the provider, the query and the topic — no address', async () => {
    const r = rig({ ready: { searxng: true }, backends: { searxng: () => SEARX_ROWS } });
    await r.manager.search('hello', { topic: 'news' });
    const call = r.calls.find((c) => c.provider === 'searxng')!;
    expect(call.args).toEqual(['searxng', 'hello', { topic: 'news' }]);
  });

  test('a server with JSON off falls back to the other engines, and is left alone for a while', async () => {
    const r = rig({
      ready: { searxng: true },
      backends: {
        searxng: () => new Error('misconfigured: This SearXNG server has JSON output turned off.'),
        duckduckgo: () => [row('DDG', 'https://ddg.example/')],
      },
    });
    const first = await r.manager.search('rust', {});
    expect(first.ok && first.provider).toBe('duckduckgo');
    expect(first.attempts.find((a) => a.provider === 'searxng')?.outcome).toBe('misconfigured');

    // Asked again straight away: not retried (it would fail the same way), still answered.
    const second = await r.manager.search('rust', {});
    expect(second.ok && second.provider).toBe('duckduckgo');
    expect(second.attempts.find((a) => a.provider === 'searxng')?.outcome).toBe('cooling-down');
    expect(r.calls.filter((c) => c.provider === 'searxng')).toHaveLength(1);

    // After the cooldown it is tried again — fixing the setting must not need a restart.
    r.advance(COOLDOWN_MS.misconfigured + 1000);
    await r.manager.search('rust', {});
    expect(r.calls.filter((c) => c.provider === 'searxng')).toHaveLength(2);
  });

  test('an unreachable server is retried next time and the others answer meanwhile', async () => {
    const r = rig({
      ready: { searxng: true },
      backends: {
        searxng: () => new Error("offline: Couldn't reach the SearXNG server — is it running?"),
        duckduckgo: () => [row('DDG', 'https://ddg.example/')],
      },
    });
    await r.manager.search('a', {});
    await r.manager.search('b', {});
    expect(r.calls.filter((c) => c.provider === 'searxng')).toHaveLength(2);
    expect(COOLDOWN_MS.offline).toBe(0);
  });

  test('rate limiting backs off briefly', async () => {
    const r = rig({
      ready: { searxng: true },
      backends: {
        searxng: () => new Error('rate: The SearXNG server is rate-limiting requests right now.'),
        duckduckgo: () => [row('DDG', 'https://ddg.example/')],
      },
    });
    await r.manager.search('a', {});
    const again = await r.manager.search('a', {});
    expect(again.attempts.find((a) => a.provider === 'searxng')?.outcome).toBe('cooling-down');
    r.advance(COOLDOWN_MS.rate + 1);
    await r.manager.search('a', {});
    expect(r.calls.filter((c) => c.provider === 'searxng')).toHaveLength(2);
  });

  test('an empty answer is not a failure, and a later engine that has results wins', async () => {
    const r = rig({
      ready: { searxng: true },
      backends: { searxng: () => [], duckduckgo: () => [row('DDG', 'https://ddg.example/')] },
    });
    const out = await r.manager.search('obscure', {});
    expect(out.ok && out.provider).toBe('duckduckgo');
    expect(out.attempts.find((a) => a.provider === 'searxng')?.outcome).toBe('empty');
  });

  test('when nothing anywhere has results, the honest answer is "none"', async () => {
    const r = rig({ ready: { searxng: true }, backends: { searxng: () => [], duckduckgo: () => [], wikipedia: () => [] } });
    const out = await r.manager.search('zzzz', {});
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.results).toEqual([]);
  });

  test('when every backend fails the outcome says so', async () => {
    const boom = () => new Error('error: nope');
    const r = rig({ ready: { searxng: true }, backends: { searxng: boom, duckduckgo: boom, wikipedia: boom } });
    const out = await r.manager.search('x', {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('all-failed');
  });
});

describe('plumbing', () => {
  test('the failure tag the native side sends is understood', () => {
    const e = classifySearchError(new Error('misconfigured: JSON output is off.'));
    expect(e).toBeInstanceOf(SearchError);
    expect(e.kind).toBe('misconfigured');
    expect(e.message).toBe('JSON output is off.');
    // The older tags still parse.
    expect(classifySearchError('quota: spent').kind).toBe('quota');
    expect(classifySearchError('offline: gone').kind).toBe('offline');
  });

  test('the provider is unavailable on a platform that cannot ask', async () => {
    const p = searxngProvider({} as Platform);
    expect(await p.isAvailable()).toBe(false);
  });

  test('readiness that throws is "not available", not an error', async () => {
    const p = searxngProvider({
      searchWebWith: async () => [],
      searchProviderReady: async () => {
        throw new Error('x');
      },
    } as unknown as Platform);
    expect(await p.isAvailable()).toBe(false);
  });
});
