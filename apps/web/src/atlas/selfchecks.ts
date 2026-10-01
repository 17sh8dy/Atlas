/**
 * The self-test checks only the app can make: storage, saved settings, execution mode and
 * whether a model is connected. See the engine's `engine.selfTest`.
 *
 * Each is a read, except the storage round-trip, which writes and removes one throwaway
 * key (`atlas.selftest.probe`) so it proves writing works without touching any real setting.
 */

import type { ExecutionMode, Storage } from '@atlas/core';
import { EXECUTION_MODES } from '@atlas/core';
import type { SelfCheck } from '@atlas/engine';
import { readAlerts } from './alerts';
import { readScroll } from './scroll';

export function appChecks(deps: { storage: Storage; executionMode: () => ExecutionMode; hasModel: () => boolean }): SelfCheck[] {
  return [
    {
      name: 'Saved settings',
      async run() {
        const key = 'atlas.selftest.probe';
        const stamp = String(Date.now());
        await deps.storage.set(key, stamp);
        const back = await deps.storage.get<string>(key);
        await deps.storage.remove(key);
        return back === stamp ? { status: 'pass', detail: 'can save and read settings' } : { status: 'fail', detail: 'a saved value did not read back' };
      },
    },
    {
      name: 'Notification and scroll settings',
      async run() {
        const [alerts, scroll] = await Promise.all([readAlerts(deps.storage), readScroll(deps.storage)]);
        const ok = alerts.volume >= 0 && alerts.volume <= 100 && scroll.speed >= 25 && scroll.speed <= 200;
        return ok ? { status: 'pass', detail: 'saved values are in range' } : { status: 'fail', detail: 'a saved value is out of range' };
      },
    },
    {
      name: 'Permissions',
      run() {
        const mode = deps.executionMode();
        return (EXECUTION_MODES as readonly string[]).includes(mode)
          ? { status: 'pass', detail: `execution mode is “${mode}”` }
          : { status: 'fail', detail: `unknown execution mode “${String(mode)}”` };
      },
    },
    {
      name: 'Language model',
      run() {
        return deps.hasModel()
          ? { status: 'pass', detail: 'a model is connected for conversation and Think longer' }
          : { status: 'warn', detail: 'no model connected — commands and everything else still work; open conversation needs one (Settings → Intelligence)' };
      },
    },
  ];
}
