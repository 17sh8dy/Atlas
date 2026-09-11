/**
 * Cloud provider *configuration* — never the key.
 *
 * Same `MemoryStore`-backed `Fact` pattern `cortex-settings.ts` already
 * uses: one subject, holding the whole list as a JSON string, because a
 * handful of provider configs is small enough that "replace the list" is
 * simpler to reason about than per-provider keys that could drift out of
 * sync with each other.
 *
 * `CloudProviderConfig` (`@atlas/core`) deliberately has no field for the
 * key — see its own doc comment. The key lives in Windows Credential
 * Manager (`secrets.rs`), addressed by `id`, and is written/read/deleted
 * through `@atlas/platform`'s `saveProviderSecret`/`hasProviderSecret`/
 * `deleteProviderSecret`, never through this module or `Storage`.
 */

import type { CloudProviderConfig, Storage } from '@atlas/core';
import { MemoryStore } from './memory-store';

const LIST_SUBJECT = 'cloudProviders.list';

export async function readCloudProviders(storage: Storage): Promise<CloudProviderConfig[]> {
  const fact = await new MemoryStore(storage).fact('preference', LIST_SUBJECT);
  if (!fact?.value) return [];
  try {
    const parsed = JSON.parse(fact.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupted or hand-edited value reads as "no providers configured"
    // rather than breaking Settings — the same fail-closed instinct
    // `readCortexSettings` applies to a malformed `enabled` value.
    return [];
  }
}

export async function writeCloudProviders(storage: Storage, configs: CloudProviderConfig[]): Promise<void> {
  await new MemoryStore(storage).remember('preference', LIST_SUBJECT, JSON.stringify(configs));
}
