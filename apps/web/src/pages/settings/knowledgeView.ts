/**
 * What the Knowledge tab prints, as plain functions so a test can hold the wording.
 *
 * Nothing here decides anything: every figure comes from `knowledge.rs` / `calibration.rs`, and
 * what cannot be known is shown as "—" with the reason, never as a made-up value.
 */

import type { CalibrationRow, KnowledgeStatus } from '@atlas/platform';

/** "Oct 24, 2026" from an ISO string; "—" when absent or unparseable. */
export function packDate(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "Oct 24, 2026, 3:05 PM" from epoch ms; "Never" for 0. */
export function whenMs(ms: number): string {
  if (!ms) return 'Never';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function sourceLabel(s: KnowledgeStatus): string {
  if (s.source === 'refreshed') return 'Refreshed copy';
  if (s.source === 'bundled') return 'Built into this Atlas';
  return 'None available';
}

/** One plain sentence about the pack's state, led by the problem when there is one. */
export function packNote(s: KnowledgeStatus): string {
  if (!s.provisioned) return "This build can't verify a knowledge pack, so it uses none.";
  if (s.source === 'none') return s.bundledProblem ?? 'No knowledge pack could be loaded.';
  if (!s.autoRefresh) return 'Automatic refresh is off, so this copy only changes when Atlas is updated.';
  return 'Checked at most once a day. A copy is used only if its signature verifies.';
}

/** The ratio as a multiplier: 1043 permille becomes "×1.04". */
export function ratioLabel(permille: number): string {
  return `×${(permille / 1000).toFixed(2)}`;
}

/** Rows worth showing first: in use, then the most samples. Does not mutate the input. */
export function sortCalibration(rows: readonly CalibrationRow[]): CalibrationRow[] {
  return [...rows].sort((a, b) => Number(b.inUse) - Number(a.inUse) || b.samples - a.samples);
}

/** What each switch contacts, printed beside it. Fixed text so the claim and the code stay together. */
export const AUTO_REFRESH_EXPLAINER =
  'Once a day Atlas asks GitHub (the Nova-Knowledge repository) whether a newer signed knowledge pack exists. ' +
  'Nothing about you or your messages is sent, only an ordinary web request. Off: Atlas never contacts GitHub for this.';

export const LIVE_LOOKUPS_EXPLAINER =
  "When you ask about something current, such as what's new in Atlas, Atlas can read Nova's public pages and say " +
  'when it did. It reads a fixed list of addresses, never one taken from a page, and sends nothing about you or ' +
  'your message. Off: Atlas answers from its saved copy and says it may be out of date.';
