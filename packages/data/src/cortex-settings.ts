/**
 * Cortex's settings: whether it is on, and where it listens.
 *
 * ── What used to be here ────────────────────────────────────────────────────
 * API keys for Claude and ChatGPT, plus which of them was active. All of it
 * is gone. The keys are gone because there is nothing left to authenticate to
 * — Cortex runs on this machine — and their absence removes the one genuinely
 * security-sensitive value Atlas was storing. `ARCHITECTURE.md` listed
 * "provider keys live in the same plaintext JSON as everything else" under
 * decisions worth revisiting; deleting the feature settles it better than
 * encrypting it would have.
 *
 * Same `MemoryStore`-backed `Fact` pattern as `preferences.ts` — subject-keyed,
 * `kind: 'preference'` — not a new store.
 *
 * ── Why an endpoint is stored at all ────────────────────────────────────────
 * So a Cortex on a non-default port can be reached without a rebuild. It is
 * not a general destination field: `validate_base_url` in `intelligence.rs`
 * refuses anything that is not loopback, so the worst a bad value can do is
 * fail to connect. The validation lives there rather than here because that
 * is the side that actually makes the request.
 */

import type { Storage } from '@atlas/core';
import { MemoryStore } from './memory-store';

const ENABLED_SUBJECT = 'cortex.enabled';
const BASE_URL_SUBJECT = 'cortex.baseUrl';
/** Kept from the old module: which provider is active, or none. */
const ACTIVE_SUBJECT = 'provider.active';

export interface CortexSettings {
  enabled: boolean;
  /** Empty means "wherever Cortex normally listens" — resolved further down. */
  baseUrl: string;
}

export async function readCortexSettings(storage: Storage): Promise<CortexSettings> {
  const memory = new MemoryStore(storage);
  const [enabled, baseUrl] = await Promise.all([
    memory.fact('preference', ENABLED_SUBJECT),
    memory.fact('preference', BASE_URL_SUBJECT),
  ]);
  return {
    // Off unless explicitly turned on. A stored value that is anything other
    // than the string 'true' reads as false, so a corrupted or half-written
    // preference fails closed rather than quietly enabling an outbound call.
    enabled: enabled?.value === 'true',
    baseUrl: typeof baseUrl?.value === 'string' ? baseUrl.value : '',
  };
}

export async function writeCortexEnabled(storage: Storage, enabled: boolean): Promise<void> {
  await new MemoryStore(storage).remember(
    'preference',
    ENABLED_SUBJECT,
    enabled ? 'true' : 'false',
  );
}

export async function writeCortexBaseUrl(storage: Storage, baseUrl: string): Promise<void> {
  await new MemoryStore(storage).remember('preference', BASE_URL_SUBJECT, baseUrl.trim());
}

export async function readActiveProvider(storage: Storage): Promise<string | undefined> {
  return (await new MemoryStore(storage).fact('preference', ACTIVE_SUBJECT))?.value;
}

/** `null` clears the active provider — the engine falls back to its local tiers. */
export async function writeActiveProvider(storage: Storage, id: string | null): Promise<void> {
  await new MemoryStore(storage).remember('preference', ACTIVE_SUBJECT, id ?? '');
}
