/**
 * @atlas/data — persistence: the `Storage` port's concrete implementations,
 * and the small preferences module built on top of it.
 *
 * `detectStorage()` takes the already-resolved `Platform['id']` rather than
 * re-sniffing the environment itself, so this package stays a sibling of
 * `@atlas/platform` (both depending only on `@atlas/core`) instead of
 * depending on it just to ask the same question twice.
 */

import type { Platform, Storage } from '@atlas/core';
import { createTauriStorage } from './tauri-storage';
import { createWebStorage } from './web-storage';

export { createTauriStorage } from './tauri-storage';
export { createWebStorage } from './web-storage';
export { writePreference, readVoiceProfile } from './preferences';
export type { PreferenceSubject } from './preferences';
export { MemoryStore } from './memory-store';
export { readSpeechPreferences, writeSpeechPreferences } from './speech-preferences';
export {
  readProviderKey,
  writeProviderKey,
  readProviderKeys,
  readActiveProvider,
  writeActiveProvider,
} from './provider-keys';
export type { ProviderKeyId } from './provider-keys';

/** The storage implementation for the given platform. */
export function detectStorage(platformId: Platform['id']): Storage {
  return platformId === 'tauri' ? createTauriStorage() : createWebStorage();
}
