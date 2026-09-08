/**
 * What Atlas calls you, what it calls itself, how it greets you, and what
 * role it plays while doing it.
 *
 * Thin, subject-typed convenience over `MemoryStore`'s general `Fact` API —
 * kept as its own module because callers (Settings, the app shell) want a
 * shaped `VoiceProfile`, not a raw fact array.
 */

import type { Storage, VoiceProfile } from '@atlas/core';
import { isAtlasRole } from '@atlas/core';
import { MemoryStore } from './memory-store';

export type PreferenceSubject = 'user.name' | 'atlas.name' | 'greeting' | 'role';

export async function writePreference(
  storage: Storage,
  subject: PreferenceSubject,
  value: string,
): Promise<void> {
  await new MemoryStore(storage).remember('preference', subject, value);
}

export async function readVoiceProfile(storage: Storage): Promise<VoiceProfile> {
  const facts = await new MemoryStore(storage).facts('preference');
  const find = (subject: PreferenceSubject) => facts.find((f) => f.subject === subject)?.value;
  // Guarded rather than cast straight through: a hand-edited store or an
  // older build's leftover value should fall back to the default role, not
  // reach `ATLAS_ROLE_META` as a key it doesn't have.
  const role = find('role');
  return {
    userName: find('user.name'),
    atlasName: find('atlas.name'),
    greeting: find('greeting'),
    role: isAtlasRole(role) ? role : undefined,
  };
}
