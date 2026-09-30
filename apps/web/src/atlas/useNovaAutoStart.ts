/**
 * Start Nova Intelligence for the person who switched it on.
 *
 * Runs in the app shell, not on the Settings page, so it works when Atlas
 * simply opens — and again the moment the switch is turned on. It does nothing
 * unless Nova Intelligence is on *and* "Start automatically" is; the person who
 * never enabled it never has a Python process started on their behalf.
 *
 * One attempt per configuration. If it can't start (no folder, no model), it
 * does not retry in a loop: Settings says what is missing and offers the fix.
 */

import { useEffect, useRef } from 'react';
import type { NovaSettings } from '@atlas/data';
import { ensureNovaIntelligence } from './novaLauncher';

export function useNovaAutoStart(nova: NovaSettings): void {
  const tried = useRef('');
  const { enabled, autoStart, folder, baseUrl } = nova;

  useEffect(() => {
    if (!enabled || !autoStart) {
      // Off, then on again, is a fresh request.
      tried.current = '';
      return;
    }
    const key = `${folder}|${baseUrl}`;
    if (tried.current === key) return;
    tried.current = key;
    void ensureNovaIntelligence({ folder, baseUrl });
  }, [enabled, autoStart, folder, baseUrl]);
}
