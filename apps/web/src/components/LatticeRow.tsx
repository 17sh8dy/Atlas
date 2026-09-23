/**
 * The one "Atlas is doing something" row — replaces the old bars-or-panel
 * switch in `Transcript.tsx` with a single component that never remounts
 * across the transition from "no step yet" to "a step is running".
 *
 * That matters for exactly the reason the old `LiveTimer`'s doc comment gave:
 * a stopwatch that restarts when the visual it sits next to changes shape
 * reads as broken. The old layout kept the clock alive by mounting it as a
 * sibling *outside* the bars/panel ternary; this one doesn't need that trick,
 * because it's the same component instance for the whole busy period — the
 * clock can just live here.
 */

import { useEffect, useState } from 'react';
import type { ActivityRun } from '@atlas/core';
import { LatticeLoader } from '@atlas/ui';
import { latticeStatusFor } from './lattice-status';
import { formatLive } from './citations';

export function LatticeRow({ run }: { run: ActivityRun | null | undefined }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const id = window.setInterval(() => setMs(performance.now() - started), 100);
    return () => window.clearInterval(id);
  }, []);

  const status = latticeStatusFor(run);
  return (
    <LatticeLoader
      phase={status.phase}
      verb={status.verb}
      label={status.label}
      elapsed={formatLive(ms)}
    />
  );
}
