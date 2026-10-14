/**
 * What the Stats page shows, as data — so the grouping, the wording and the number formatting can
 * be tested without rendering anything.
 *
 * Every number comes from `stats.rs` (counted on this PC). Nothing here computes a statistic; it
 * only arranges and formats. Where a figure is an estimate (model tokens, unless the provider
 * reported its own) the row says so.
 */

import type { StatsPeriod, StatsSummary } from '@atlas/platform';

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

/** Tokens are shown as ≈ because Atlas counts about four characters to a token unless told. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `≈ ${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `≈ ${(n / 1_000).toFixed(1)}k`;
  return `≈ ${count(n)}`;
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
      r('Local tokens', tokens(modelTokens('model.local')), 'Estimated.'),
      r('Cloud model requests', count(m('model.cloud.requests')), 'Sent to the provider you chose.'),
      r('Cloud tokens', tokens(modelTokens('model.cloud')), 'As the provider reported, otherwise estimated.'),
      r('Cloud requests that failed', count(m('model.cloud.failures'))),
      r('Times a cloud limit was reached', count(m('model.cloud.limit_hits'))),
      r('Nova Intelligence requests', count(m('model.nova.requests'))),
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
      r('Time with Atlas on screen', minutes(m('app.minutes_open'))),
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
  if (p.limitHits) parts.push(`limit reached ${count(p.limitHits)}×`);
  return parts.join(' · ');
}
