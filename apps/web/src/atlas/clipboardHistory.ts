/**
 * The on/off setting for clipboard history. Off by default: nothing is watched or kept
 * until the person turns it on, and turning it off forgets everything.
 *
 * Only the switch is stored. The history itself never is — see the engine's
 * `clipboard/history.ts`.
 *
 * Storage key is lowercase (storage.rs refuses anything else).
 */

import type { Storage } from '@atlas/core';

export const CLIPBOARD_HISTORY_KEY = 'atlas.settings.clipboard-history';
export const CLIPBOARD_HISTORY_CHANGED = 'atlas:clipboard-history-changed';

export async function readClipboardHistoryEnabled(storage: Storage): Promise<boolean> {
  try {
    return (await storage.get<{ enabled?: unknown }>(CLIPBOARD_HISTORY_KEY))?.enabled === true;
  } catch {
    return false;
  }
}

export async function writeClipboardHistoryEnabled(storage: Storage, enabled: boolean): Promise<void> {
  await storage.set(CLIPBOARD_HISTORY_KEY, { enabled });
  try {
    window.dispatchEvent(new CustomEvent(CLIPBOARD_HISTORY_CHANGED, { detail: enabled }));
  } catch {
    /* not in a browser (tests) */
  }
}
