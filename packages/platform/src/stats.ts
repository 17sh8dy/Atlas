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
  /** Estimated cost in US dollars, only where the prices were entered for this provider. */
  estCostUsd: number | null;
}

/** An ESTIMATE of cloud spending, from the prices the person entered. Never a bill. */
export interface StatsSpend {
  /** null until at least one provider has prices to estimate from. */
  estimateUsd: number | null;
  pricedProviders: number;
  unpricedProviders: number;
  /** Tokens no price covers, so the figure can say how much it leaves out. */
  unpricedTokens: number;
}

/** All-time figures: the same whichever period is chosen. */
export interface StatsLifetime {
  activeSeconds: number;
  messages: number;
  tokens: number;
  /** Tokens used by models that run on this PC. Free, and a different thing from cloud tokens. */
  localTokens: number;
  /** How much of `localTokens` the model server counted itself; the rest is Atlas's estimate. */
  localTokensReported: number;
  /** Tokens sent to cloud providers, as Atlas counted them. Never authoritative: the provider is. */
  cloudTokens: number;
  /** Of `cloudTokens`: the part Atlas estimated because the provider did not report it. */
  cloudTokensEstimated: number;
  /** Of `cloudTokens` since `cloudSplitFrom`: the part the provider reported itself. */
  cloudTokensConfirmed: number;
  /** Cloud tokens from before the split existed: confirmed vs estimated was not recorded. */
  cloudTokensUnsplit: number;
  /** Of cloud input: the part served from the provider's cache (already inside `cloudTokens`). */
  cloudTokensCached: number;
  /** Input of requests that may have been billed and then failed. NOT in `cloudTokens`. */
  cloudTokensUncertain: number;
  /** First day (YYYY-MM-DD) recorded with the split. */
  cloudSplitFrom: string;
  conversations: number;
  tasksCompleted: number;
  filesEdited: number;
  spend: StatsSpend;
}

export interface StatsStreak {
  current: number;
  longest: number;
  /** The last day of the longest streak, YYYY-MM-DD, or empty. */
  longestEnded: string;
  activeToday: boolean;
}

export interface StatsCalendarDay {
  day: string;
  /** 0 = nothing; 1-4 = how much, relative to the busiest day shown. */
  level: number;
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
  /** Active minutes over the same buckets as `series`. */
  activeSeries: { label: string; value: number }[];
  /** Estimated spending for the chosen period. */
  spend: StatsSpend;
  lifetime: StatsLifetime;
  streak: StatsStreak;
  /** The last twelve weeks, one cell a day, oldest first. */
  calendar: StatsCalendarDay[];
  /** The first day active time was counted, or empty if it has not been yet. */
  activeSince: string;
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

/**
 * Tell Atlas the person just used it, so active time can be counted. Carries nothing but the fact
 * that it happened. Never throws.
 */
export async function statsTouch(): Promise<void> {
  try {
    await invoke<void>('stats_touch');
  } catch {
    /* counting must never break what is counted */
  }
}

/** Start counting from nothing. Asks natively first; rejects if the answer is no. */
export async function statsReset(): Promise<void> {
  await invoke<void>('stats_reset');
}
