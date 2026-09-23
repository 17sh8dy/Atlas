/**
 * The one "Atlas is doing something" row — the lattice header from before,
 * now combined with React Bits' "Thought Line" *motion* pattern (explicitly
 * not its "reasoning-trace" framing — see below): a short, always-visible
 * list of the run's real steps appears beneath the header while it runs, and
 * the whole thing settles into a single line through a blur crossfade once
 * the run really ends.
 *
 * ── What "settle" means here, and what it doesn't ───────────────────────────
 * React Bits describes Thought Line as a "reasoning-trace header" that
 * settles into "Thought for [duration]". Atlas has no reasoning trace to show
 * — see `lattice-status.ts` and `packages/core/src/models/activity.ts` for
 * why that channel doesn't exist here — so this borrows only the *visual*
 * beat (glyph+label+clock, a short list beneath, a crossfade collapse into
 * one line) and drives it from exactly the same `ActivityRun` the old
 * `ActivityPanel` disclosure read from. The settled line is
 * `summarizeRun(run)`'s real, already-existing output ("Ran 3 actions",
 * "Stopped after 1 of 4 actions", …) plus the real elapsed time — never
 * "Thought for …", and never anything sourced from a model.
 *
 * ── Reusing `ActivityPanel`'s rows rather than a third implementation ───────
 * The step list below is `StepRow`/`StateDot`, imported from
 * `ActivityPanel.tsx` (now exported for exactly this). Before this change,
 * `Transcript.tsx` rendered this lattice header *and*, separately,
 * `ActivityPanel`'s own click-to-expand disclosure underneath it — both
 * showing the same run. Since the steps are now always visible here (Thought
 * Line's steps aren't gated behind a click), that second render was pure
 * duplication, so `Transcript.tsx` no longer renders `ActivityPanel`
 * directly. `ActivityPanel` itself is untouched and still exported — see its
 * own doc comment — in case a collapsed, on-demand version of this is wanted
 * again later; it just isn't wired into the live conversation view any more.
 *
 * ── The crossfade is CSS state, not a timer ─────────────────────────────────
 * Both the "expanded" (header + steps) and "settled" (one line) layers are
 * always in the DOM, grid-stacked on top of each other, and which one is
 * visible is driven purely by `phase !== 'active'` through a Tailwind
 * `transition`. There is no `setTimeout` sequencing the swap — the browser's
 * own transition on the opacity/blur classes *is* the crossfade, which is
 * also what makes the "settled" layer's content correct on the very first
 * render a resolved `run` is passed in (no animation to wait out first),
 * checked in `lattice-row.test.tsx`.
 */

import { useEffect, useState } from 'react';
import type { ActivityRun } from '@atlas/core';
import { LatticeLoader, cn } from '@atlas/ui';
import { latticeStatusFor } from './lattice-status';
import { formatLive } from './citations';
import { StepRow } from './ActivityPanel';

/** Both crossfade layers occupy the same grid cell, so the swap has nothing to reflow around. */
const LAYER = '[grid-area:1/1] transition-[opacity,filter] duration-slow ease-out motion-reduce:transition-none';

export function LatticeRow({ run }: { run: ActivityRun | null | undefined }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const id = window.setInterval(() => setMs(performance.now() - started), 100);
    return () => window.clearInterval(id);
  }, []);

  const status = latticeStatusFor(run);
  const elapsed = formatLive(ms);
  const settled = status.phase !== 'active';
  const steps = run?.steps ?? [];

  return (
    <div className="grid">
      {/* Expanded: the live header plus each real step, in plan order. */}
      <div
        aria-hidden={settled}
        className={cn(LAYER, settled ? 'pointer-events-none opacity-0 blur-sm' : 'opacity-100 blur-0')}
      >
        <LatticeLoader phase="active" verb={status.verb} label={status.label} elapsed={elapsed} />
        {steps.length > 0 && (
          <div className="border-border ml-[5px] mt-1.5 border-l pl-3.5">
            {/*
             * `StepRow`'s `now` is compared against `step.startedAt`/`endedAt`,
             * which are `Date.now()` epoch ms (see `activity.ts`) — not
             * `performance.now()`, which the `ms` state above uses for its own
             * unrelated monotonic tick. Read fresh each render, which already
             * happens on the same 100ms cadence as that tick.
             */}
            {steps.map((step) => (
              <StepRow key={step.id} step={step} now={Date.now()} />
            ))}
          </div>
        )}
      </div>

      {/* Settled: one line, from the same real data — never a fake outcome. */}
      <div
        aria-hidden={!settled}
        className={cn(LAYER, settled ? 'opacity-100 blur-0' : 'pointer-events-none opacity-0 blur-sm')}
      >
        <LatticeLoader phase={status.phase} verb={status.verb} label={status.label} elapsed={elapsed} />
      </div>
    </div>
  );
}
