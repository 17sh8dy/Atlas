/**
 * Atlas Stats — the phone line to `stats.rs`.
 *
 * Everything here is read from, and written to, a file on this PC. Nothing is sent anywhere, and
 * nothing depends on an account. See `stats.rs` for what is counted and why it is only counts.
 */

import { invoke } from '@tauri-apps/api/core';

export type StatsPeriod =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'month'
  | 'year'
  | 'lastyear'
  | 'lifetime';

export interface ProviderUsage {
  id: string;
  label: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  failures: number;
  limitHits: number;
}

export interface StatsSummary {
  period: StatsPeriod;
  label: string;
  from: string;
  to: string;
  since: string;
  daysWithActivity: number;
  metrics: Record<string, number>;
  providers: ProviderUsage[];
  series: { label: string; value: number }[];
}

export interface StatsInfo {
  since: string;
  daysRecorded: number;
  sizeBytes: number;
}

export async function statsSummary(period: StatsPeriod): Promise<StatsSummary> {
  return invoke<StatsSummary>('stats_summary', { period });
}

export async function statsInfo(): Promise<StatsInfo> {
  return invoke<StatsInfo>('stats_info');
}

/** Record outcomes only the interface sees. Never throws: counting must not break what is counted. */
export async function statsRecord(metric: string, count = 1): Promise<void> {
  try {
    await invoke<void>('stats_record', { metric, count });
  } catch {
    /* a stats problem is never the user's problem */
  }
}

/** Start counting from nothing. Asks natively first; rejects if the answer is no. */
export async function statsReset(): Promise<void> {
  await invoke<void>('stats_reset');
}
