/**
 * The app's copy of the presence settings (see core `models/presence.ts`).
 *
 * Settings → General → Background writes them and announces the change with a window event, the same way the
 * alert settings do, so the rest of the app follows without a reload and without Settings knowing who listens.
 * Whatever the native side needs to know (what the close button does) is pushed to it from here, once on load
 * and again on every change: the native copy only ever lives in memory and defaults to today's behaviour.
 */

import { useEffect, useState } from 'react';
import type { Platform, PresencePreferences, Storage } from '@atlas/core';
import { DEFAULT_PRESENCE } from '@atlas/core';
import { readPresencePreferences } from '@atlas/data';

export const PRESENCE_CHANGED = 'atlas:presence-changed';

export function announcePresenceChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PRESENCE_CHANGED));
}

export function usePresence(storage: Storage, platform: Platform): PresencePreferences {
  const [prefs, setPrefs] = useState<PresencePreferences>(DEFAULT_PRESENCE);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void readPresencePreferences(storage)
        .catch(() => DEFAULT_PRESENCE)
        .then((next) => {
          if (!alive) return;
          setPrefs(next);
          void platform.setQuitOnClose?.(next.quitOnClose).catch(() => {});
        });
    load();
    window.addEventListener(PRESENCE_CHANGED, load);
    return () => {
      alive = false;
      window.removeEventListener(PRESENCE_CHANGED, load);
    };
  }, [storage, platform]);

  return prefs;
}
