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
 *
 * The page is a dashboard in three layers: the all-time headline figures (which do not move with the
 * period), the activity calendar and streaks, and then the per-period detail the page has always had.
 * Every figure is read from `stats.rs`; nothing here computes a statistic. What cannot be known is
 * shown as "—" with the reason beside it, never as a made-up number.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Icons, Surface, cn } from '@atlas/ui';
import type { Platform, Storage } from '@atlas/core';
import { statsInfo, statsReset, statsSummary, isTauri } from '@atlas/platform';
import type { StatsInfo, StatsPeriod, StatsSummary } from '@atlas/platform';
import { PERIODS, calendarGrid, count, groupsFor, highlightsFor, isEmpty, providerLine } from './statsView';

const PERIOD_KEY = 'atlas.stats.period';

/** Shade for each activity level, 0 (nothing) to 4 (the busiest day shown). */
const LEVEL_CLASS = ['bg-border/40', 'bg-primary/25', 'bg-primary/45', 'bg-primary/70', 'bg-primary'] as const;

interface Props {
  platform: Platform;
  storage: Storage;
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="text-foreground-subtle mb-2 text-xs font-medium uppercase tracking-wide">{children}</h3>;
}

/** A row of bars, one per day (or per month for a long period). Scales to the busiest bar. */
function BarChart({ title, unit, points }: { title: string; unit: string; points: StatsSummary['series'] }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <Surface className="mb-3 p-4">
      <SectionTitle>{title}</SectionTitle>
      <div className="flex h-20 items-end gap-1" role="img" aria-label={`${title} over the period`}>
        {points.map((p) => (
          <div
            key={p.label}
            title={`${p.label}: ${count(p.value)}${unit}`}
            className="bg-primary/70 min-w-[3px] flex-1 rounded-sm"
            style={{ height: `${Math.max(4, Math.round((p.value / max) * 100))}%` }}
          />
        ))}
      </div>
      <div className="text-foreground-subtle mt-1 flex justify-between text-[10px]">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </Surface>
  );
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

  const weeks = summary ? calendarGrid(summary.calendar) : [];
  const anyActiveTime = !!summary && summary.activeSeries.some((p) => p.value > 0);

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
          {error && <p className="text-danger mb-3 text-xs">{error}</p>}

          {summary && (
            <>
              <h3 className="text-foreground-subtle mb-2 text-xs font-medium uppercase tracking-wide">All time</h3>
              <div
                className="mb-3 grid gap-2"
                style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(8.25rem, 1fr))' }}
                aria-label="All-time figures"
              >
                {highlightsFor(summary).map((h) => (
                  <Surface key={h.id} className="min-w-0 p-3" data-highlight={h.id}>
                    <div className="text-foreground-subtle text-[11px] font-medium uppercase tracking-wide">
                      {h.label}
                    </div>
                    <div className="text-foreground mt-1 break-words text-xl font-semibold tabular-nums">
                      {h.value}
                    </div>
                    <p className="text-foreground-subtle mt-1 text-[11px] leading-snug">{h.note}</p>
                  </Surface>
                ))}
              </div>

              <Surface className="mb-4 p-4">
                <SectionTitle>Activity, last 12 weeks</SectionTitle>
                <div
                  className="grid gap-[3px]"
                  style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}
                  role="img"
                  aria-label={`Days you used Atlas in the last 12 weeks. Current streak ${summary.streak.current} days.`}
                >
                  {weeks.map((week, wi) => (
                    <div key={wi} className="grid grid-rows-7 gap-[3px]">
                      {week.map((cell, di) =>
                        cell ? (
                          <div
                            key={cell.day}
                            title={`${cell.day}${cell.level ? '' : ' · no activity'}`}
                            className={cn('aspect-square min-w-0 rounded-[3px]', LEVEL_CLASS[cell.level] ?? LEVEL_CLASS[0])}
                          />
                        ) : (
                          <div key={`pad-${wi}-${di}`} className="aspect-square min-w-0" />
                        ),
                      )}
                    </div>
                  ))}
                </div>
                <div className="text-foreground-subtle mt-2 flex items-center justify-end gap-1 text-[10px]">
                  <span>Less</span>
                  {LEVEL_CLASS.map((c) => (
                    <span key={c} className={cn('h-2.5 w-2.5 rounded-[2px]', c)} />
                  ))}
                  <span>More</span>
                </div>
              </Surface>
            </>
          )}

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

          {summary && isEmpty(summary) && (
            <Surface className="mb-3 p-4">
              <p className="text-foreground-muted text-sm">
                Nothing counted for {summary.label.toLowerCase()} yet. Use Atlas and it will appear here.
              </p>
            </Surface>
          )}

          {summary && summary.series.length > 1 && (
            <BarChart title="Activity" unit="" points={summary.series} />
          )}
          {summary && summary.activeSeries.length > 1 && anyActiveTime && (
            <BarChart title="Time using Atlas (minutes)" unit=" min" points={summary.activeSeries} />
          )}

          {summary &&
            groupsFor(summary).map((group) => (
              <Surface key={group.id} className="mb-3 p-4">
                <SectionTitle>{group.title}</SectionTitle>
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
              <SectionTitle>By cloud provider</SectionTitle>
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
