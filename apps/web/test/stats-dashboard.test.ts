import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StatsSummary } from '@atlas/platform';
import {
  calendarGrid,
  days,
  duration,
  groupsFor,
  cloudTokensNote,
  highlightsFor,
  providerLine,
  spendNote,
  usd,
  CLOUD_AUTHORITY,
  localTokensValue,
} from '../src/pages/settings/statsView';
import { formatPriceMilli, parsePriceMilli, priceTextProblem } from '../src/pages/settings/intelligence/prices';
import { PULSE_EVENTS, PULSE_EVERY_MS, shouldPulse } from '../src/atlas/useActivityPulse';
import { filesEditedBy, metricsForPlan } from '../src/atlas/statsRecord';

const emptySpend = { estimateUsd: null, pricedProviders: 0, unpricedProviders: 0, unpricedTokens: 0 };

function summary(over: Partial<StatsSummary> = {}): StatsSummary {
  return {
    period: 'lifetime',
    label: 'Lifetime',
    from: '',
    to: '',
    since: '2026-10-18',
    daysWithActivity: 0,
    metrics: {},
    providers: [],
    series: [],
    activeSeries: [],
    spend: emptySpend,
    lifetime: {
      activeSeconds: 0,
      messages: 0,
      tokens: 0,
      localTokens: 0,
      localTokensReported: 0,
      cloudTokens: 0,
      cloudTokensEstimated: 0,
      cloudTokensConfirmed: 0,
      cloudTokensUnsplit: 0,
      cloudTokensCached: 0,
      cloudTokensUncertain: 0,
      cloudSplitFrom: '2026-10-21',
      conversations: 0,
      tasksCompleted: 0,
      filesEdited: 0,
      spend: emptySpend,
    },
    streak: { current: 0, longest: 0, longestEnded: '', activeToday: false },
    calendar: [],
    activeSince: '',
    ...over,
  };
}

const byId = (s: StatsSummary) => Object.fromEntries(highlightsFor(s).map((h) => [h.id, h]));

describe('the dashboard headline figures', () => {
  test('are the ten the page promises, in order', () => {
    expect(highlightsFor(summary()).map((h) => h.id)).toEqual([
      'active-time',
      'streak-current',
      'streak-longest',
      'messages',
      'local-tokens',
      'cloud-tokens',
      'conversations',
      'tasks',
      'files',
      'spend',
    ]);
  });

  test('read the all-time figures, whatever period was chosen', () => {
    const s = summary({
      period: 'today',
      lifetime: {
        activeSeconds: 3 * 3600 + 12 * 60,
        messages: 1234,
        tokens: 2_500_000,
        localTokens: 2_000_000,
        localTokensReported: 2_000_000,
        cloudTokens: 500_000,
        conversations: 40,
        tasksCompleted: 7,
        filesEdited: 19,
        spend: { estimateUsd: 4.5, pricedProviders: 1, unpricedProviders: 0, unpricedTokens: 0 },
      },
      streak: { current: 3, longest: 9, longestEnded: '2026-09-01', activeToday: true },
    });
    const h = byId(s);
    expect(h['active-time']!.value).toBe('3 h 12 min');
    expect(h['messages']!.value).toBe('1,234');
    expect(h['local-tokens']!.value).toBe('2.0M');
    expect(h['cloud-tokens']!.value).toBe('≈ 500.0k');
    expect(h['conversations']!.value).toBe('40');
    expect(h['tasks']!.value).toBe('7');
    expect(h['files']!.value).toBe('19');
    expect(h['streak-current']!.value).toBe('3 days');
    expect(h['streak-longest']!.value).toBe('9 days');
    expect(h['streak-longest']!.note).toContain('2026-09-01');
    expect(h['spend']!.value).toBe('$4.50');
  });

  test('say what each one is, so nothing is assumed', () => {
    for (const h of highlightsFor(summary())) expect(h.note.length, h.id).toBeGreaterThan(10);
    const h = byId(summary());
    expect(h['active-time']!.note).toMatch(/not while it sits open/i);
    expect(h['conversations']!.note).toMatch(/30 minutes/);
    expect(h['files']!.note).toMatch(/never records file names/i);
    expect(h['cloud-tokens']!.note).toMatch(/never a guarantee/i);
  });

  test('never invent history: a fresh install is zeros and "—", with the reason', () => {
    const h = byId(summary());
    expect(h['active-time']!.value).toBe('0 s');
    expect(h['active-time']!.note).toMatch(/counting starts the first time/i);
    expect(h['spend']!.value).toBe('—');
    expect(h['spend']!.note).toMatch(/no cloud ai use/i);
  });

  test('active time says since when it was counted, once it has been', () => {
    const h = byId(summary({ activeSince: '2026-10-18', lifetime: { ...summary().lifetime, activeSeconds: 600 } }));
    expect(h['active-time']!.note).toContain('Counted since 2026-10-18');
  });

  test('a streak is described honestly when today has not happened yet', () => {
    const alive = byId(summary({ streak: { current: 2, longest: 2, longestEnded: '2026-10-17', activeToday: false } }));
    expect(alive['streak-current']!.note).toMatch(/use atlas today to keep it going/i);
    const none = byId(summary());
    expect(none['streak-current']!.value).toBe('0 days');
    expect(none['streak-current']!.note).toMatch(/start one/i);
    expect(byId(summary({ streak: { current: 1, longest: 1, longestEnded: '', activeToday: true } }))['streak-current']!.value).toBe(
      '1 day',
    );
  });
});

describe('local tokens and cloud tokens are different things', () => {
  const withTokens = (local: number, reported: number, cloud: number) =>
    byId(summary({ lifetime: { ...summary().lifetime, localTokens: local, localTokensReported: reported, cloudTokens: cloud } }));

  test('local tokens say whether the model server counted them or Atlas estimated', () => {
    expect(withTokens(10_000, 10_000, 0)['local-tokens']!.note).toMatch(/counted by your model server/i);
    expect(withTokens(10_000, 0, 0)['local-tokens']!.note).toMatch(/estimated/i);
    expect(withTokens(10_000, 4_000, 0)['local-tokens']!.note).toMatch(/partly counted/i);
    expect(withTokens(0, 0, 0)['local-tokens']!.note).toMatch(/costs nothing/i);
  });

  test('a count the server gave is shown plainly; an estimate keeps its ≈', () => {
    expect(localTokensValue(34_100, 34_100)).toBe('34.1k');
    expect(localTokensValue(34_100, 0)).toBe('≈ 34.1k');
    expect(localTokensValue(0, 0)).toBe('≈ 0');
  });

  test('local use is free and is never mixed into the cloud figure', () => {
    const h = withTokens(5_000_000, 0, 120);
    expect(h['local-tokens']!.value).not.toBe(h['cloud-tokens']!.value);
    expect(h['cloud-tokens']!.value).toBe('≈ 120');
    expect(h['local-tokens']!.note).toMatch(/costs nothing/i);
  });

  test('every cloud figure says the provider, not Atlas, is the authority', () => {
    const everywhere = [
      byId(summary())['cloud-tokens']!.note,
      byId(summary())['spend']!.note,
      spendNote({ estimateUsd: 1, pricedProviders: 1, unpricedProviders: 0, unpricedTokens: 0 }, true),
      CLOUD_AUTHORITY,
      ...groupsFor(summary()).flatMap((g) => g.rows).filter((r) => /^Cloud (model requests|tokens)$/.test(r.label)).map((r) => r.note ?? ''),
    ];
    // ("No cloud AI use to estimate" is the absence of a figure, not a figure.)
    for (const text of everywhere.filter((t) => /cloud|provider|spending/i.test(t) && !/no cloud ai use/i.test(t))) {
      expect(text, text).toMatch(/provider/i);
    }
    expect(CLOUD_AUTHORITY).toMatch(/not a guarantee/i);
    expect(spendNote({ estimateUsd: 1, pricedProviders: 1, unpricedProviders: 0, unpricedTokens: 0 }, true)).toMatch(/only real figure/i);
  });
});

describe('spending is only ever an estimate', () => {
  test('uses "—", not $0.00, when it cannot be estimated', () => {
    const s = summary({
      lifetime: { ...summary().lifetime, spend: { estimateUsd: null, pricedProviders: 0, unpricedProviders: 2, unpricedTokens: 900 } },
    });
    const h = byId(s)['spend']!;
    expect(h.value).toBe('—');
    expect(h.note).toMatch(/no prices are set/i);
    expect(h.note).toMatch(/Settings → Intelligence/);
  });

  test('says what the figure leaves out', () => {
    const note = spendNote({ estimateUsd: 1.25, pricedProviders: 1, unpricedProviders: 2, unpricedTokens: 12_000 }, true);
    expect(note).toMatch(/estimate from the prices you entered, not a bill/i);
    expect(note).toMatch(/leaves out ≈ 12.0k tokens from 2 providers/i);
  });

  test('formats dollars without pretending to be precise', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(0.004)).toBe('< $0.01');
    expect(usd(12.345)).toBe('$12.35');
    expect(usd(1234.5)).toBe('$1,234.50');
  });

  test('a provider line carries its own estimate only when it has a price', () => {
    const base = { id: 'p', label: 'P', requests: 3, tokensIn: 100, tokensOut: 50, failures: 0, limitHits: 0 };
    expect(providerLine({ ...base, estCostUsd: null })).not.toContain('estimated');
    expect(providerLine({ ...base, estCostUsd: 0.5 })).toContain('≈ $0.50 estimated');
  });

  test('the per-period group says the same, and the same caveat', () => {
    const rows = groupsFor(summary({ spend: { estimateUsd: 2, pricedProviders: 1, unpricedProviders: 0, unpricedTokens: 0 } }))
      .flatMap((g) => g.rows)
      .filter((r) => r.label === 'Estimated cloud spending');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe('$2.00');
  });
});

describe('time and number formatting', () => {
  test('active time is shown in seconds under a minute, then minutes, then hours', () => {
    expect(duration(0)).toBe('0 s');
    expect(duration(45)).toBe('45 s');
    expect(duration(60)).toBe('1 min');
    expect(duration(3 * 3600 + 5 * 60 + 30)).toBe('3 h 5 min');
    expect(duration(2 * 3600)).toBe('2 h');
  });

  test('days are pluralised', () => {
    expect(days(0)).toBe('0 days');
    expect(days(1)).toBe('1 day');
    expect(days(12)).toBe('12 days');
  });
});

describe('the activity calendar grid', () => {
  const day = (iso: string, level = 0) => ({ day: iso, level });

  test('lays weeks out Monday to Sunday, padding the first week to its weekday', () => {
    // 2026-10-14 is a Wednesday: two blank cells (Mon, Tue) come first.
    const grid = calendarGrid([day('2026-10-14'), day('2026-10-15'), day('2026-10-16')]);
    expect(grid).toHaveLength(1);
    expect(grid[0]!.slice(0, 2)).toEqual([null, null]);
    expect(grid[0]![2]!.day).toBe('2026-10-14');
    expect(grid[0]![4]!.day).toBe('2026-10-16');
    expect(grid[0]!.slice(5)).toEqual([null, null]);
  });

  test('twelve weeks of days make at most 13 columns of 7', () => {
    const start = Date.UTC(2026, 6, 27); // a Monday
    const list = Array.from({ length: 84 }, (_, i) => day(new Date(start + i * 86_400_000).toISOString().slice(0, 10)));
    const grid = calendarGrid(list);
    expect(grid).toHaveLength(12);
    expect(grid.every((w) => w.length === 7)).toBe(true);
    expect(grid.flat().filter(Boolean)).toHaveLength(84);
  });

  test('an empty calendar is an empty grid', () => {
    expect(calendarGrid([])).toEqual([]);
  });
});

describe('provider prices', () => {
  test('are held as whole thousandths of a dollar, so nothing is lost to floating point', () => {
    expect(parsePriceMilli('2.5')).toBe(2500);
    expect(parsePriceMilli('$2.50')).toBe(2500);
    expect(parsePriceMilli('0.075')).toBe(75);
    expect(parsePriceMilli('15')).toBe(15000);
    expect(parsePriceMilli('0')).toBe(0);
    expect(parsePriceMilli('1,000')).toBe(1_000_000);
  });

  test('blank and nonsense are "no price", not zero', () => {
    expect(parsePriceMilli('')).toBeNull();
    expect(parsePriceMilli('   ')).toBeNull();
    expect(parsePriceMilli('abc')).toBeNull();
    expect(parsePriceMilli('-3')).toBeNull();
    expect(priceTextProblem('')).toBeNull();
    expect(priceTextProblem('2.5')).toBeNull();
    expect(priceTextProblem('two')).toMatch(/number/i);
  });

  test('round-trip for display', () => {
    expect(formatPriceMilli(2500)).toBe('2.5');
    expect(formatPriceMilli(75)).toBe('0.075');
    expect(formatPriceMilli(null)).toBe('');
  });
});

describe('active time is use, not presence', () => {
  test('only deliberate input counts: a key, a click, a scroll', () => {
    expect([...PULSE_EVENTS]).toEqual(['pointerdown', 'keydown', 'wheel']);
    expect(PULSE_EVENTS).not.toContain('mousemove' as never);
  });

  test('signals are throttled so counting costs almost nothing', () => {
    expect(shouldPulse(0, 1)).toBe(true);
    expect(shouldPulse(1000, 1000 + PULSE_EVERY_MS - 1)).toBe(false);
    expect(shouldPulse(1000, 1000 + PULSE_EVERY_MS)).toBe(true);
  });

  test('the app mounts it once, at the root', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/app/AtlasApp.tsx', import.meta.url)), 'utf8');
    expect(src.match(/useActivityPulse\(\)/g)).toHaveLength(1);
  });
});

describe('files edited', () => {
  test('counts edits to existing files, not creating, copying, moving or deleting', () => {
    expect(filesEditedBy('code.edit', undefined)).toBe(1);
    expect(filesEditedBy('code.write', undefined)).toBe(1);
    expect(filesEditedBy('files.append', undefined)).toBe(1);
    for (const skill of ['files.create', 'files.copy', 'files.move', 'files.delete', 'files.readText', 'code.search']) {
      expect(filesEditedBy(skill, undefined), skill).toBe(0);
    }
  });

  test('a bulk edit counts the files it actually changed', () => {
    expect(filesEditedBy('code.replaceAll', { files: ['a.ts', 'b.ts', 'c.ts'] })).toBe(3);
    expect(filesEditedBy('code.replaceAll', undefined)).toBe(1);
  });

  test('is counted once per finished step, and not for one that failed or was declined', () => {
    const plan = {
      ok: true,
      ran: 1,
      aborted: false,
      outcomes: [
        { skill: 'code.edit', ok: true },
        { skill: 'code.edit', ok: false, error: 'not found' },
        { skill: 'code.write', ok: false, skipped: true, error: 'Cancelled.' },
      ],
    };
    const m = new Map(metricsForPlan(plan as never));
    expect(m.get('files.edited')).toBe(1);
  });
});

describe('cloud token certainty (2.0.3)', () => {
  const lt = (over: Partial<ReturnType<typeof summary>['lifetime']>) => ({ ...summary().lifetime, ...over });

  test('says how much was reported, estimated and unsplit, and never guesses the unsplit part', () => {
    const note = cloudTokensNote(
      lt({ cloudTokens: 1500, cloudTokensConfirmed: 350, cloudTokensEstimated: 150, cloudTokensUnsplit: 1000, cloudTokensCached: 40 }),
    );
    expect(note).toContain('reported by the provider');
    expect(note).toContain('estimated by Atlas');
    expect(note).toContain('before this split was recorded');
    expect(note).toContain('provider’s cache');
  });

  test('shows the uncertain row only when there is something uncertain', () => {
    expect(highlightsFor(summary()).map((h) => h.id)).not.toContain('cloud-uncertain');
    const ids = highlightsFor({ ...summary(), lifetime: lt({ cloudTokensUncertain: 4000 }) }).map((h) => h.id);
    expect(ids).toContain('cloud-uncertain');
  });

  test('explains that uncertain tokens count toward the limit but not the lifetime total', () => {
    const h = highlightsFor({ ...summary(), lifetime: lt({ cloudTokensUncertain: 4000 }) }).find((x) => x.id === 'cloud-uncertain')!;
    expect(h.note).toMatch(/monthly limit/);
    expect(h.note).toMatch(/not your lifetime total/);
  });
});
