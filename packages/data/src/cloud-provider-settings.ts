/**
 * Cloud provider *configuration* — never the key — **read-only here**.
 *
 * In the desktop app the provider list is held natively (`provider_bindings.rs`): it decides where
 * a saved key may be sent, so the renderer reads it from there and changes it only through
 * `@atlas/platform`'s `addProviderWithKey` / `updateProvider` / `bindProvider`. What is left in
 * this module is the reader of the *old* preference fact, kept for the browser build (which has no
 * keys) and as the source the native one-time migration carries over. There is deliberately no
 * writer.
 *
 * Same `MemoryStore`-backed `Fact` pattern `local-ai-settings.ts` already
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
    // `readLocalAiSettings` applies to a malformed `enabled` value.
    return [];
  }
}

