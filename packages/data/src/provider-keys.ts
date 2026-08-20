/**
 * API keys for Claude and ChatGPT, and which provider (if any) is active.
 *
 * Same `MemoryStore`-backed `Fact` pattern as `preferences.ts` — subject
 * -keyed, `kind: 'preference'` — not a new store. Keys sit in the same
 * local JSON file as everything else Atlas remembers about you; there is no
 * separate encrypted-keychain integration. That's a real, known limitation
 * for a security-sensitive value on a feature this new, not an oversight —
 * worth revisiting in `docs/ARCHITECTURE.md`'s "decisions worth revisiting."
 */

import type { Storage } from '@atlas/core';
import { MemoryStore } from './memory-store';

export type ProviderKeyId = 'claude' | 'openai';

const keySubject = (id: ProviderKeyId) => `provider.${id}.apiKey`;
const ACTIVE_SUBJECT = 'provider.active';

export async function readProviderKey(storage: Storage, id: ProviderKeyId): Promise<string | undefined> {
  return (await new MemoryStore(storage).fact('preference', keySubject(id)))?.value;
}

export async function writeProviderKey(storage: Storage, id: ProviderKeyId, key: string): Promise<void> {
  await new MemoryStore(storage).remember('preference', keySubject(id), key);
}

/** All saved keys in one read, for app startup. Missing keys are simply absent. */
export async function readProviderKeys(storage: Storage): Promise<Partial<Record<ProviderKeyId, string>>> {
  const memory = new MemoryStore(storage);
  const [claude, openai] = await Promise.all([
    memory.fact('preference', keySubject('claude')),
    memory.fact('preference', keySubject('openai')),
  ]);
  const out: Partial<Record<ProviderKeyId, string>> = {};
  if (claude?.value) out.claude = claude.value;
  if (openai?.value) out.openai = openai.value;
  return out;
}

export async function readActiveProvider(storage: Storage): Promise<string | undefined> {
  return (await new MemoryStore(storage).fact('preference', ACTIVE_SUBJECT))?.value;
}

/** `null` clears the active provider — engine falls back to offline replies, same as today. */
export async function writeActiveProvider(storage: Storage, id: string | null): Promise<void> {
  await new MemoryStore(storage).remember('preference', ACTIVE_SUBJECT, id ?? '');
}
