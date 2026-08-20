/**
 * The Tauri implementation of the `Storage` port.
 *
 * Same "deliberately dumb" shape as `@atlas/platform`'s `tauri.ts`: each
 * method is a one-line `invoke` of a command in `src-tauri/src/storage.rs`,
 * which owns the actual file (one JSON document in the app's data directory)
 * and the key validation. Nothing is enforced here.
 */

import type { Storage } from '@atlas/core';
import { invoke } from '@tauri-apps/api/core';

export function createTauriStorage(): Storage {
  return {
    get: <T>(key: string) => invoke<T | undefined>('storage_get', { key }),
    set: <T>(key: string, value: T) => invoke<void>('storage_set', { key, value }),
    remove: (key: string) => invoke<void>('storage_remove', { key }),
  };
}
