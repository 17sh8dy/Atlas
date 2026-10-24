/**
 * The knowledge pack — the phone line to `knowledge.rs`.
 *
 * The native side verifies every pack against a compiled-in signing key before it is used, and
 * fetches only from one pinned address. What comes back here is already trusted-as-signed, but it is
 * still data: nothing here interprets it.
 */

import { invoke } from '@tauri-apps/api/core';

export type KnowledgeSource = 'none' | 'bundled' | 'refreshed';

export interface KnowledgeStatus {
  source: KnowledgeSource;
  seq: number | null;
  builtAt: string | null;
  bundledSeq: number | null;
  /** False in a build with no knowledge key: nothing can verify. */
  provisioned: boolean;
  autoRefresh: boolean;
  /** Whether Atlas may read Nova's public pages to answer a question about something current. */
  liveLookups: boolean;
  lastCheckedMs: number;
  lastUpdatedMs: number;
  lastError: string | null;
  bundledProblem: string | null;
}

export interface LoadedKnowledgePack {
  source: 'bundled' | 'refreshed';
  seq: number;
  builtAt: string;
  /** The verified pack file, as text. */
  text: string;
}

export async function knowledgeStatus(): Promise<KnowledgeStatus> {
  return invoke<KnowledgeStatus>('knowledge_status');
}

/** The verified pack, or null when nothing verified. */
export async function knowledgePack(): Promise<LoadedKnowledgePack | null> {
  const p = await invoke<{ source: 'none' | 'bundled' | 'refreshed'; seq: number; builtAt: string; text: string } | null>('knowledge_pack');
  return p && p.source !== 'none' ? { source: p.source, seq: p.seq, builtAt: p.builtAt, text: p.text } : null;
}

/** Look for a newer pack now. A failure is reported in the returned status (`lastError`). */
export async function knowledgeCheckNow(): Promise<KnowledgeStatus> {
  return invoke<KnowledgeStatus>('knowledge_check_now');
}

export async function knowledgeSetAutoRefresh(enabled: boolean): Promise<KnowledgeStatus> {
  return invoke<KnowledgeStatus>('knowledge_set_auto_refresh', { enabled });
}

export async function knowledgeSetLiveLookups(enabled: boolean): Promise<KnowledgeStatus> {
  return invoke<KnowledgeStatus>('knowledge_set_live_lookups', { enabled });
}

// ---- live lookups of Nova's public pages (layer 3) -----------------------------------------------

/** The fixed list of pages Atlas may read live. The native side holds the addresses; this is only the ids. */
export type LiveSourceId =
  | 'atlas-release'
  | 'replay-release'
  | 'nova-cut-release'
  | 'site-nova'
  | 'site-atlas'
  | 'site-replay'
  | 'site-nova-cut'
  | 'site-help'
  | 'site-review'
  | 'site-legal';

export interface LiveResult {
  sourceId: LiveSourceId;
  label: string;
  /** The exact address read, for the "Live from" line. */
  url: string;
  fetchedAtMs: number;
  title: string;
  published: string | null;
  /** The visible text, capped. DATA: unsigned, never verified. */
  text: string;
  /** Too little readable text came back (a page that needs scripts to show anything). */
  thin: boolean;
}

/** Rejects with `live-lookups-off` when the person turned lookups off. */
export async function knowledgeLiveFetch(sourceId: LiveSourceId): Promise<LiveResult> {
  return invoke<LiveResult>('knowledge_live_fetch', { sourceId });
}

// ---- calibration (the "Token accuracy" table) ------------------------------------------------

export interface CalibrationRow {
  provider: string;
  model: string;
  kind: string;
  samples: number;
  ratioPermille: number;
  inUse: boolean;
}

export async function calibrationStatus(): Promise<CalibrationRow[]> {
  return invoke<CalibrationRow[]>('calibration_status');
}

export async function calibrationReset(): Promise<void> {
  await invoke<void>('calibration_reset');
}
