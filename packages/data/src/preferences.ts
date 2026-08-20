/**
 * What Atlas calls you, what it calls itself, and how it greets you.
 *
 * Thin, subject-typed convenience over `MemoryStore`'s general `Fact` API —
 * kept as its own module because callers (Settings, the app shell) want a
 * shaped `VoiceProfile`, not a raw fact array.
 */

import type { Storage, VoiceProfile } from '@atlas/core';
import { MemoryStore } from './memory-store';

export type PreferenceSubject = 'user.name' | 'atlas.name' | 'greeting';

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
  return {
    userName: find('user.name'),
    atlasName: find('atlas.name'),
    greeting: find('greeting'),
  };
}
