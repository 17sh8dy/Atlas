/**
 * What the Stats page shows, as data — so the grouping, the wording and the number formatting can
 * be tested without rendering anything.
 *
 * Every number comes from `stats.rs` (counted on this PC). Nothing here computes a statistic; it
 * only arranges and formats. Where a figure is an estimate (model tokens, unless the provider
 * reported its own) the row says so.
 */

import type { StatsCalendarDay, StatsLifetime, StatsPeriod, StatsSpend, StatsSummary } from '@atlas/platform';

export const PERIODS: readonly { id: StatsPeriod; label: string }[] = [
  { id: 'lifetime', label: 'Lifetime' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
  { id: 'year', label: 'This year' },
  { id: 'lastyear', label: 'Last year' },
];

export interface StatRow {
  label: string;
  value: string;
  /** A plain note under the number: what it counts, or that it is an estimate. */
  note?: string;
}

export interface StatGroup {
  id: string;
  title: string;
  rows: StatRow[];
}

export function count(n: number): string {
  return n.toLocaleString('en-US');
}

/** "3 h 12 min", "45 min", "0 min". */
export function minutes(n: number): string {
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${count(h)} h ${m} min` : `${count(h)} h`;
}

/** Active time, from seconds: "45 s", "3 min", "3 h 12 min". Under a minute is said in seconds. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  return minutes(Math.floor(seconds / 60));
}

/** US dollars for an ESTIMATE: two decimals, and "< $0.01" rather than a misleading "$0.00". */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return '< $0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "1 day", "12 days". */
export function days(n: number): string {
  return `${count(n)} day${n === 1 ? '' : 's'}`;
}

/** Local tokens, said honestly: counted by the model server, estimated, or a mixture. */
export function localTokensNote(total: number, reported: number): string {
  const free = 'Runs on this PC and costs nothing.';
  if (total === 0) return `Models that run on this PC. ${free}`;
  if (reported >= total) return `Counted by your model server. ${free}`;
  if (reported <= 0) return `Estimated (about 4 characters to a token): your model server did not report counts. ${free}`;
  return `Partly counted by your model server, partly estimated. ${free}`;
}

/** The count itself: exact words when the server counted every token, otherwise with a ≈. */
export function localTokensValue(total: number, reported: number): string {
  const compact = tokens(total).replace('≈ ', '');
  return total > 0 && reported >= total ? compact : tokens(total);
}

/** The line that keeps the record straight about cloud numbers, wherever they appear. */
export const CLOUD_AUTHORITY =
  'These are Atlas’s own counts, not a guarantee. Your provider’s dashboard and bill are the real figures.';

/** Tokens are shown as ≈ because Atlas counts about four characters to a token unless told. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `≈ ${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `≈ ${(n / 1_000).toFixed(1)}k`;
  return `≈ ${count(n)}`;
}

/** One of the headline figures at the top of the dashboard. */
export interface Highlight {
  id: string;
  label: string;
  value: string;
  /** What it counts, or what it cannot say — never left to be assumed. */
  note: string;
}

/** What an estimate covers and, just as important, what it leaves out. */
export function spendNote(spend: StatsSpend, hasCloudUse: boolean): string {
  if (spend.estimateUsd === null) {
    return hasCloudUse
      ? 'Not estimated: no prices are set for the cloud providers you used. Add them in Settings → Intelligence.'
      : 'No cloud AI use to estimate.';
  }
  const left =
    spend.unpricedTokens > 0
      ? ` Leaves out ${tokens(spend.unpricedTokens)} tokens from ${count(spend.unpricedProviders)} provider${spend.unpricedProviders === 1 ? '' : 's'} with no price set.`
      : '';
  return `An estimate from the prices you entered, not a bill. Your provider’s bill is the only real figure.${left}`;
}

/**
 * How sure the cloud token figure is: how much the provider reported, how much Atlas estimated,
 * and how much is from before that split was recorded (never guessed at).
 */
export function cloudTokensNote(l: StatsLifetime): string {
  const parts: string[] = [];
  if (l.cloudTokensConfirmed > 0) parts.push(`${tokens(l.cloudTokensConfirmed)} reported by the provider`);
  if (l.cloudTokensEstimated > 0) parts.push(`${tokens(l.cloudTokensEstimated)} estimated by Atlas`);
  if (l.cloudTokensUnsplit > 0) parts.push(`${tokens(l.cloudTokensUnsplit)} from before this split was recorded`);
  const cached = l.cloudTokensCached > 0 ? ` Of the input, ${tokens(l.cloudTokensCached)} came from the provider’s cache.` : '';
  const lead = parts.length ? `${parts.join(' · ')}.` : 'Atlas’s own count.';
  return `${lead}${cached} Never a guarantee: your provider’s dashboard is the authority.`;
}

/**
 * The headline figures. All-time, so they do not move when the period below is changed, and every
 * one says plainly what it is: a number Atlas could not measure is shown as "—" with the reason,
 * never as a zero that looks like a measurement.
 */
export function highlightsFor(s: StatsSummary): Highlight[] {
  const l = s.lifetime;
  const h = (id: string, label: string, value: string, note: string): Highlight => ({ id, label, value, note });
  const streakNote = (() => {
    if (s.streak.current === 0) return 'Days you used Atlas in a row. Use it today to start one.';
    return s.streak.activeToday
      ? 'Days you used Atlas in a row, counting today.'
      : 'Days in a row. Use Atlas today to keep it going.';
  })();
  const hasCloudUse = l.spend.pricedProviders + l.spend.unpricedProviders > 0;
  return [
    h(
      'active-time',
      'Time using Atlas',
      duration(l.activeSeconds),
      s.activeSince
        ? `Only while you are using it, not while it sits open. Counted since ${s.activeSince}.`
        : 'Only while you are using it, not while it sits open. Counting starts the first time you use it.',
    ),
    h('streak-current', 'Current streak', days(s.streak.current), streakNote),
    h(
      'streak-longest',
      'Longest streak',
      days(s.streak.longest),
      s.streak.longest > 0 && s.streak.longestEnded ? `Ended ${s.streak.longestEnded}.` : 'Days you used Atlas in a row.',
    ),
    h('messages', 'Messages sent', count(l.messages), 'Everything you have typed or said to Atlas.'),
    h(
      'local-tokens',
      'Local model tokens',
      localTokensValue(l.localTokens, l.localTokensReported),
      localTokensNote(l.localTokens, l.localTokensReported),
    ),
    h('cloud-tokens', 'Cloud tokens (Atlas’s count)', tokens(l.cloudTokens), cloudTokensNote(l)),
    ...(l.cloudTokensUncertain > 0
      ? [
          h(
            'cloud-uncertain',
            'Cloud tokens that may have been billed',
            tokens(l.cloudTokensUncertain),
            'These requests may have reached your provider before failing. They count toward your monthly limit but not your lifetime total.',
          ),
        ]
      : []),
    h('conversations', 'Conversations', count(l.conversations), 'Messages less than 30 minutes apart count as one.'),
    h('tasks', 'Tasks completed', count(l.tasksCompleted), 'Multi-step tasks that finished.'),
    h('files', 'Files edited', count(l.filesEdited), 'Edits made, not distinct files. Atlas never records file names.'),
    h(
      'spend',
      'Estimated cloud spending',
      l.spend.estimateUsd === null ? '—' : usd(l.spend.estimateUsd),
      spendNote(l.spend, hasCloudUse),
    ),
  ];
}

/** The calendar as a grid of weeks: columns oldest to newest, rows Monday to Sunday, padded so each day sits under its weekday. */
export function calendarGrid(days: readonly StatsCalendarDay[]): (StatsCalendarDay | null)[][] {
  if (!days.length) return [];
  const first = days[0]!;
  const [y, m, d] = first.day.split('-').map(Number) as [number, number, number];
  // JavaScript: Sunday = 0. Monday-first: Monday = 0.
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  const cells: (StatsCalendarDay | null)[] = [...Array<null>(weekday).fill(null), ...days];
  const weeks: (StatsCalendarDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    const week = cells.slice(i, i + 7);
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return weeks;
}

export function groupsFor(s: StatsSummary): StatGroup[] {
  const m = (k: string) => s.metrics[k] ?? 0;
  const g = (id: string, title: string, rows: StatRow[]): StatGroup => ({ id, title, rows });
  const r = (label: string, value: string, note?: string): StatRow => ({ label, value, ...(note ? { note } : {}) });

  const modelTokens = (prefix: string) => m(`${prefix}.tokens_in`) + m(`${prefix}.tokens_out`);

  return [
    g('conversation', 'Conversation', [
      r('Messages you sent', count(m('chat.messages_sent'))),
      r('Answered by a connected model', count(m('chat.replies_model'))),
      r('Answered by Atlas itself', count(m('chat.replies_atlas')), 'Commands and replies that needed no model.'),
    ]),
    g('actions', 'Actions', [
      r('Done', count(m('actions.done'))),
      r('Failed', count(m('actions.failed'))),
      r('You said no', count(m('actions.declined'))),
      r('Stopped', count(m('actions.halted'))),
      r('Files', count(m('area.files'))),
      r('System', count(m('area.system'))),
      r('Web', count(m('area.web'))),
      r('Apps', count(m('area.apps'))),
      r('Developer tools', count(m('area.dev'))),
      r('Keyboard and mouse', count(m('area.input'))),
      r('Other', count(m('area.other'))),
    ]),
    g('tasks', 'Tasks', [
      r('Completed', count(m('tasks.completed'))),
      r('Failed', count(m('tasks.failed'))),
      r('Cancelled', count(m('tasks.cancelled'))),
    ]),
    g('models', 'Models', [
      r('Local model requests', count(m('model.local.requests')), 'On this PC; nothing leaves it.'),
      r(
        'Local tokens',
        localTokensValue(modelTokens('model.local'), m('model.local.tokens_reported')),
        localTokensNote(modelTokens('model.local'), m('model.local.tokens_reported')),
      ),
      r('Cloud model requests', count(m('model.cloud.requests')), 'Sent to the provider you chose. Counted by Atlas; your provider’s records are the authority.'),
      r('Cloud tokens', tokens(modelTokens('model.cloud')), 'Atlas’s count (the provider’s number where it gave one). Not a guarantee: your provider’s dashboard is the authority.'),
      r('  of which estimated', tokens(m('model.cloud.tokens_in_est') + m('model.cloud.tokens_out_est')), 'Estimated by Atlas because the provider did not report them.'),
      r('  of input, from cache', tokens(m('model.cloud.tokens_cached_in')), 'Already counted in the cloud tokens above.'),
      r('Cloud tokens that may have been billed', tokens(m('model.cloud.tokens_unc_in')), 'Requests that may have reached the provider before failing. Counted toward a monthly limit, not the total above.'),
      r('Cloud requests that failed', count(m('model.cloud.failures'))),
      r('Times a cloud limit was reached', count(m('model.cloud.limit_hits'))),
      r('Nova Intelligence requests', count(m('model.nova.requests'))),
      r(
        'Estimated cloud spending',
        s.spend.estimateUsd === null ? '—' : usd(s.spend.estimateUsd),
        spendNote(s.spend, s.spend.pricedProviders + s.spend.unpricedProviders > 0),
      ),
    ]),
    g('web', 'Web', [
      r('Searches', count(m('search.web'))),
      r('Pages fetched', count(m('search.fetches'))),
    ]),
    g('voice', 'Voice', [
      r('Times Atlas listened', count(m('voice.heard'))),
      r('Times Atlas spoke', count(m('voice.spoken'))),
    ]),
    g('safety', 'Safety', [
      r('Confirmation questions', count(m('safety.questions_asked')), 'The Windows boxes that ask before a lasting change.'),
      r('You approved', count(m('safety.questions_approved'))),
      r('You declined', count(m('safety.questions_declined'))),
      r('Closed by the stop key', count(m('safety.questions_stopped'))),
      r('Unanswered', count(m('safety.questions_timed_out'))),
      r('Emergency stops', count(m('safety.stops'))),
    ]),
    g('time', 'Time', [
      r('Times Atlas was opened', count(m('app.launches'))),
      r('Time using Atlas', duration(m('app.active_seconds')), 'Only while you are using it.'),
      r('Time with Atlas on screen', minutes(m('app.minutes_open')), 'Includes time it was just left open.'),
    ]),
  ];
}

/** Whether anything at all has been counted in the period. */
export function isEmpty(s: StatsSummary): boolean {
  return Object.values(s.metrics).every((v) => v === 0) && s.providers.length === 0;
}

export function providerLine(p: StatsSummary['providers'][number]): string {
  const parts = [`${count(p.requests)} request${p.requests === 1 ? '' : 's'}`, `${tokens(p.tokensIn + p.tokensOut)} tokens`];
  if (p.failures) parts.push(`${count(p.failures)} failed`);
  if (p.estCostUsd !== null) parts.push(`≈ ${usd(p.estCostUsd)} estimated`);
  if (p.limitHits) parts.push(`limit reached ${count(p.limitHits)}×`);
  return parts.join(' · ');
}
