/**
 * Stats — what you have done with Atlas, counted on this PC.
 *
 * "Your activity. Your statistics. Your device."
 *
 *   · No Nova Account is needed to see this, and signing in, out, or deleting an account does not
 *     touch it.
 *   · Nothing here is sent anywhere, and there is no setting that makes it so.
 *   · It is counts, not content: never what you said, opened or searched for.
 *   · It survives updating Atlas.
 *
 * One honest caveat is printed on the page and is real: asking a cloud model still sends that
 * request to the provider you chose. Keeping the *statistics* local does not make those requests
 * private from that provider.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Icons, Surface } from '@atlas/ui';
import type { Platform, Storage } from '@atlas/core';
import { statsInfo, statsReset, statsSummary, isTauri } from '@atlas/platform';
import type { StatsInfo, StatsPeriod, StatsSummary } from '@atlas/platform';
import { PERIODS, count, groupsFor, isEmpty, providerLine } from './statsView';

const PERIOD_KEY = 'atlas.stats.period';

interface Props {
  platform: Platform;
  storage: Storage;
}

export function Stats({ storage }: Props) {
  const [period, setPeriod] = useState<StatsPeriod>('lifetime');
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [info, setInfo] = useState<StatsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const native = isTauri();

  // The last period you looked at is remembered, so the page opens where you left it.
  useEffect(() => {
    let alive = true;
    void storage
      .get<string>(PERIOD_KEY)
      .then((p) => {
        if (alive && PERIODS.some((x) => x.id === p)) setPeriod(p as StatsPeriod);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [storage]);

  const load = useCallback(async () => {
    if (!native) return;
    try {
      const [s, i] = await Promise.all([statsSummary(period), statsInfo()]);
      setSummary(s);
      setInfo(i);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [native, period]);

  useEffect(() => {
    void load();
    // Counted continuously while Atlas runs, so the page refreshes itself gently.
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const choose = (p: StatsPeriod) => {
    setPeriod(p);
    void storage.set(PERIOD_KEY, p).catch(() => {});
  };

  const reset = async () => {
    setResetting(true);
    setError(null);
    try {
      await statsReset();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  };

  const max = Math.max(1, ...(summary?.series.map((p) => p.value) ?? [0]));

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <Icons.BarChart3 className="text-primary h-4 w-4" />
        <h2 className="text-foreground text-sm font-medium">Stats</h2>
      </div>
      <p className="text-foreground-muted mb-1 text-xs leading-relaxed">
        <strong className="text-foreground font-medium">Your activity. Your statistics. Your device.</strong>
      </p>
      <p className="text-foreground-muted mb-4 text-xs leading-relaxed">
        Counted on this PC only. No Nova Account, no subscription, nothing sent to Nova or anyone else.
        They are counts, never what you said or opened, and they stay when you update Atlas, sign out,
        or delete an account.
      </p>

      {!native ? (
        <Surface className="p-4">
          <p className="text-foreground-muted text-sm">
            Statistics are kept by the Atlas desktop app. This page has nothing to show in a browser.
          </p>
        </Surface>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="text-foreground-subtle text-xs font-medium uppercase tracking-wide" htmlFor="stats-period">
              Period
            </label>
            <select
              id="stats-period"
              value={period}
              onChange={(e) => choose(e.target.value as StatsPeriod)}
              className="border-border bg-surface text-foreground h-9 rounded-lg border px-3 text-sm"
            >
              {PERIODS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {summary && (
              <span className="text-foreground-subtle text-xs">
                {summary.daysWithActivity === 0
                  ? 'No activity in this period'
                  : `${count(summary.daysWithActivity)} day${summary.daysWithActivity === 1 ? '' : 's'} with activity`}
                {summary.since ? ` · counting since ${summary.since}` : ''}
              </span>
            )}
          </div>

          {error && <p className="text-danger mb-3 text-xs">{error}</p>}

          {summary && isEmpty(summary) && (
            <Surface className="mb-3 p-4">
              <p className="text-foreground-muted text-sm">
                Nothing counted for {summary.label.toLowerCase()} yet. Use Atlas and it will appear here.
              </p>
            </Surface>
          )}

          {summary && summary.series.length > 1 && (
            <Surface className="mb-3 p-4">
              <h3 className="text-foreground-subtle mb-2 text-xs font-medium uppercase tracking-wide">
                Activity
              </h3>
              <div className="flex h-20 items-end gap-1" role="img" aria-label="Activity over the period">
                {summary.series.map((p) => (
                  <div
                    key={p.label}
                    title={`${p.label}: ${count(p.value)}`}
                    className="bg-primary/70 min-w-[3px] flex-1 rounded-sm"
                    style={{ height: `${Math.max(4, Math.round((p.value / max) * 100))}%` }}
                  />
                ))}
              </div>
              <div className="text-foreground-subtle mt-1 flex justify-between text-[10px]">
                <span>{summary.series[0]?.label}</span>
                <span>{summary.series[summary.series.length - 1]?.label}</span>
              </div>
            </Surface>
          )}

          {summary &&
            groupsFor(summary).map((group) => (
              <Surface key={group.id} className="mb-3 p-4">
                <h3 className="text-foreground-subtle mb-2 text-xs font-medium uppercase tracking-wide">
                  {group.title}
                </h3>
                <dl className="divide-border divide-y">
                  {group.rows.map((row) => (
                    <div key={row.label} className="flex items-baseline justify-between gap-4 py-1.5">
                      <div className="min-w-0">
                        <dt className="text-foreground text-sm">{row.label}</dt>
                        {row.note && <dd className="text-foreground-subtle text-xs">{row.note}</dd>}
                      </div>
                      <span className="text-foreground text-sm tabular-nums">{row.value}</span>
                    </div>
                  ))}
                </dl>
              </Surface>
            ))}

          {summary && summary.providers.length > 0 && (
            <Surface className="mb-3 p-4">
              <h3 className="text-foreground-subtle mb-2 text-xs font-medium uppercase tracking-wide">
                By cloud provider
              </h3>
              <ul className="divide-border divide-y">
                {summary.providers.map((p) => (
                  <li key={p.id} className="py-1.5">
                    <div className="text-foreground text-sm">{p.label}</div>
                    <div className="text-foreground-subtle text-xs">{providerLine(p)}</div>
                  </li>
                ))}
              </ul>
              <p className="text-foreground-subtle mt-2 text-xs leading-relaxed">
                Requests to these providers go to the provider you chose. Keeping these counts on this PC
                does not make those requests private from that provider.
              </p>
            </Surface>
          )}

          <Surface className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-foreground-subtle text-xs leading-relaxed">
                {info
                  ? `Kept in a ${(Math.max(1, info.sizeBytes) / 1024).toFixed(1)} KB file in Atlas's data folder, ${count(info.daysRecorded)} day${info.daysRecorded === 1 ? '' : 's'} recorded.`
                  : 'Kept in a small file in Atlas’s data folder.'}
              </p>
              <Button variant="ghost" size="sm" disabled={resetting} className="text-danger" onClick={() => void reset()}>
                <Icons.Trash2 className="h-3.5 w-3.5" />
                Reset statistics
              </Button>
            </div>
          </Surface>
        </>
      )}
    </section>
  );
}
