import { describe, expect, test } from 'vitest';
import type { Platform, WebSearchResult } from '@atlas/core';
import {
  COOLDOWN_MS,
  SearchError,
  SearchManager,
  type SearchProvider,
} from '../src/web/search-manager';
import {
  classifySearchError,
  createSearchManager,
  encyclopediaQuery,
  wikipediaProvider,
} from '../src/web/providers';

const hit = (title: string): WebSearchResult => ({
  title,
  url: `https://${title}.example/`,
  snippet: title,
});

interface FakeOpts {
  available?: boolean;
  results?: WebSearchResult[];
  throws?: SearchError | Error;
}

function fake(id: string, opts: FakeOpts = {}) {
  const calls: string[] = [];
  const state = { ...opts };
  const provider: SearchProvider = {
    id,
    label: id.toUpperCase(),
    isAvailable: async () => state.available ?? true,
    async search(query) {
      calls.push(query);
      if (state.throws) throw state.throws;
      return state.results ?? [hit(id)];
    },
  };
  return { provider, calls, state };
}

describe('SearchManager — provider selection', () => {
  test('uses the first provider when it works, and never touches the second', async () => {
    const a = fake('tavily');
    const b = fake('ddg');
    const m = new SearchManager([a.provider, b.provider]);
    const out = await m.search('q');
    expect(out.ok && out.provider).toBe('tavily');
    expect(b.calls).toEqual([]);
  });

  test('no key: the keyed provider is skipped silently and the next answers', async () => {
    const a = fake('tavily', { available: false });
    const b = fake('ddg');
    const out = await new SearchManager([a.provider, b.provider]).search('q');
    expect(out.ok && out.provider).toBe('ddg');
    expect(a.calls).toEqual([]);
    expect(out.attempts[0]).toMatchObject({ provider: 'tavily', outcome: 'unavailable' });
  });

  test('every result is stamped with the provider that returned it', async () => {
    const out = await new SearchManager([fake('ddg').provider]).search('q');
    expect(out.ok && out.results.every((r) => r.provider === 'ddg')).toBe(true);
  });

  test('nothing available at all → a structured outcome, not an exception', async () => {
    const out = await new SearchManager([
      fake('tavily', { available: false }).provider,
      fake('ddg', { available: false }).provider,
    ]).search('q');
    expect(out).toMatchObject({ ok: false, reason: 'none-available' });
  });

  test('an empty answer from one provider lets the next try; an all-empty result is still ok', async () => {
    const a = fake('tavily', { results: [] });
    const b = fake('ddg', { results: [hit('found')] });
    const out = await new SearchManager([a.provider, b.provider]).search('q');
    expect(out.ok && out.provider).toBe('ddg');

    const c = fake('tavily', { results: [] });
    const d = fake('ddg', { results: [] });
    const none = await new SearchManager([c.provider, d.provider]).search('q');
    expect(none).toMatchObject({ ok: true, results: [] });
  });
});

describe('SearchManager — quota and failures', () => {
  test('quota exhausted → falls back immediately, with no error surfaced', async () => {
    const a = fake('tavily', { throws: new SearchError('quota', 'used up') });
    const b = fake('ddg');
    const out = await new SearchManager([a.provider, b.provider]).search('q');
    expect(out.ok && out.provider).toBe('ddg');
    expect(out.attempts.map((x) => x.outcome)).toEqual(['quota', 'ok']);
  });

  test('after a quota refusal the exhausted provider is not asked again until the cooldown passes', async () => {
    let t = 1_000_000;
    const a = fake('tavily', { throws: new SearchError('quota', 'used up') });
    const b = fake('ddg');
    const m = new SearchManager([a.provider, b.provider], () => t);

    await m.search('one');
    expect(a.calls).toHaveLength(1);

    t += COOLDOWN_MS.quota - 1;
    const second = await m.search('two');
    expect(a.calls).toHaveLength(1); // not asked again
    expect(second.attempts[0]?.outcome).toBe('cooling-down');

    t += 2;
    a.state.throws = undefined; // the allowance refilled
    const third = await m.search('three');
    expect(a.calls).toHaveLength(2);
    expect(third.ok && third.provider).toBe('tavily');
  });

  test('a rejected key backs off for a shorter time than a spent quota', () => {
    expect(COOLDOWN_MS.auth).toBeLessThan(COOLDOWN_MS.quota);
    expect(COOLDOWN_MS.rate).toBeLessThan(COOLDOWN_MS.auth);
  });

  test('a plain unexpected error skips that provider for this search only', async () => {
    const a = fake('tavily', { throws: new Error('boom') });
    const b = fake('ddg');
    const m = new SearchManager([a.provider, b.provider]);
    await m.search('one');
    await m.search('two');
    expect(a.calls).toHaveLength(2); // no cooldown for a generic error
  });

  test('reset() forgets cooldowns, for when the user has just changed a key', async () => {
    const a = fake('tavily', { throws: new SearchError('auth', 'bad key') });
    const b = fake('ddg');
    const m = new SearchManager([a.provider, b.provider]);
    await m.search('one');
    a.state.throws = undefined;
    m.reset();
    const out = await m.search('two');
    expect(out.ok && out.provider).toBe('tavily');
  });

  test('all providers failing → all-failed, and it does not throw', async () => {
    const out = await new SearchManager([
      fake('tavily', { throws: new SearchError('quota', 'x') }).provider,
      fake('ddg', { throws: new SearchError('blocked', 'captcha') }).provider,
    ]).search('q');
    expect(out).toMatchObject({ ok: false, reason: 'all-failed' });
  });

  test('a provider whose isAvailable throws is treated as unavailable', async () => {
    const bad: SearchProvider = {
      id: 'x',
      label: 'X',
      isAvailable: async () => {
        throw new Error('credential store unreachable');
      },
      search: async () => [hit('x')],
    };
    const out = await new SearchManager([bad, fake('ddg').provider]).search('q');
    expect(out.ok && out.provider).toBe('ddg');
  });
});

describe('classifySearchError', () => {
  test.each([
    ['quota: monthly allowance used', 'quota'],
    ['AUTH: key rejected', 'auth'],
    ['rate: slow down', 'rate'],
    ["The search engine wants to confirm this isn't automated traffic.", 'blocked'],
    ["Couldn't reach the search engine — check the connection.", 'offline'],
    ['something else entirely', 'error'],
  ])('%s → %s', (msg, kind) => {
    expect(classifySearchError(new Error(msg)).kind).toBe(kind);
  });

  test('a tagged message loses its tag in the text a person might read', () => {
    expect(classifySearchError(new Error('quota: used up')).message).toBe('used up');
  });

  test('a bare string rejection (what Tauri invoke gives) is handled', () => {
    expect(classifySearchError('quota: used up').kind).toBe('quota');
  });
});

describe('createSearchManager — the real wiring against a fake platform', () => {
  const platformOf = (over: Partial<Platform>): Platform =>
    ({ id: 'test', capabilities: async () => ({}), ...over }) as Platform;

  test('Tavily is tried first when a key is saved, and DuckDuckGo is the fallback', async () => {
    const asked: string[] = [];
    const platform = platformOf({
      searchProviderReady: async () => true,
      searchWebWith: async (provider) => {
        asked.push(provider);
        if (provider === 'tavily') throw new Error('quota: used up');
        return [hit('ddg')];
      },
    });
    const out = await createSearchManager(platform).search('q');
    expect(asked).toEqual(['tavily', 'duckduckgo']);
    expect(out.ok && out.provider).toBe('duckduckgo');
  });

  test('no key saved: Tavily is never called', async () => {
    const asked: string[] = [];
    const platform = platformOf({
      searchProviderReady: async () => false,
      searchWebWith: async (provider) => {
        asked.push(provider);
        return [hit('ddg')];
      },
    });
    await createSearchManager(platform).search('q');
    expect(asked).toEqual(['duckduckgo']);
  });

  test('an older platform with only searchWeb still works, as DuckDuckGo', async () => {
    const platform = platformOf({ searchWeb: async () => [hit('legacy')] });
    const out = await createSearchManager(platform).search('q');
    expect(out.ok && out.provider).toBe('duckduckgo');
  });

  test('a platform that cannot search at all yields none-available', async () => {
    const out = await createSearchManager(platformOf({})).search('q');
    expect(out).toMatchObject({ ok: false, reason: 'none-available' });
  });
});

describe('Wikipedia, the keyless knowledge backup', () => {
  const platformOf = (over: Partial<Platform>): Platform =>
    ({ id: 'test', capabilities: async () => ({}), ...over }) as Platform;

  test('it is last in line: Tavily, then DuckDuckGo, then Wikipedia', () => {
    expect(createSearchManager(platformOf({})).order()).toEqual([
      'tavily',
      'duckduckgo',
      'wikipedia',
    ]);
  });

  test('no key and DuckDuckGo blocked: Wikipedia answers, and nothing is reported as an error', async () => {
    const asked: string[] = [];
    const platform = platformOf({
      searchProviderReady: async () => false,
      searchWebWith: async (provider) => {
        asked.push(provider);
        if (provider === 'duckduckgo') throw new Error("blocked: confirm this isn't automated");
        return [hit('wiki')];
      },
    });
    const out = await createSearchManager(platform).search('Fortnite');
    expect(asked).toEqual(['duckduckgo', 'wikipedia']);
    expect(out.ok && out.provider).toBe('wikipedia');
  });

  test('a blocked DuckDuckGo is not asked again for a while, so the next question goes straight to Wikipedia', async () => {
    const asked: string[] = [];
    const platform = platformOf({
      searchProviderReady: async () => false,
      searchWebWith: async (provider) => {
        asked.push(provider);
        if (provider === 'duckduckgo') throw new Error('blocked: captcha');
        return [hit('wiki')];
      },
    });
    const m = createSearchManager(platform);
    await m.search('one');
    await m.search('two');
    expect(asked).toEqual(['duckduckgo', 'wikipedia', 'wikipedia']);
  });
});

describe('encyclopediaQuery', () => {
  test.each([
    ['Fortnite current season September 2026', 'Fortnite season'],
    ['Apex Legends latest September 2026', 'Apex Legends'],
    ['Lakers game last night September 2026', 'Lakers game last night'],
    ['2026 FIFA World Cup', '2026 FIFA World Cup'],
    ['black hole', 'black hole'],
  ])('%s -> %s', (input, want) => {
    expect(encyclopediaQuery(input)).toBe(want);
  });

  test('never reduces a query to nothing', () => {
    expect(encyclopediaQuery('now')).toBe('now');
  });

  test('the cleaned query is what reaches Wikipedia', async () => {
    const sent: string[] = [];
    const platform = {
      id: 'test',
      capabilities: async () => [],
      searchWebWith: async (_p: string, q: string) => {
        sent.push(q);
        return [hit('wiki')];
      },
    } as unknown as Platform;
    await wikipediaProvider(platform).search('Fortnite current season September 2026', {});
    expect(sent).toEqual(['Fortnite season']);
  });
});
