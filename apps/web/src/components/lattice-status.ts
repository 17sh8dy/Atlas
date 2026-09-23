/**
 * What the lattice shows, derived from the real activity stream and nothing
 * else.
 *
 * ── Why this reads `ActivityRun`, not a parallel state machine ─────────────
 * No duplicate state system: every field returned here is read straight off
 * the same `ActivityRun` the expandable panel (`ActivityPanel.tsx`) already
 * renders from — `useActivity`'s reduction of the engine's own `activity:step`
 * events. There is no second source of truth to keep in sync with the first,
 * and nothing below is estimated, guessed, or invented.
 *
 * ── Why there is no "Planning" phase ────────────────────────────────────────
 * The engine has no event between "asked" (`engine:ask`) and "the first step
 * ran" (the first `activity:step`) that says what it is doing in between —
 * grammar matching, an AI plan being drafted, or nothing at all for a plain
 * question (see `engine.ts`'s `askWith`). Inventing a "Planning" label for
 * that gap would be exactly the kind of phase-detection heuristic the data
 * doesn't support, so it stays "Thinking" — honest about not knowing more —
 * until a real step exists to describe.
 *
 * ── Why "Testing" and not a fuller taxonomy ─────────────────────────────────
 * `test.run`'s and `build.run`'s own domain is real, already-catalogued data
 * (see `devtools-skills.ts`'s own doc comment on why they're grouped) — using
 * it is not a heuristic, it's reading a fact the skill catalog already
 * declares about itself. Both map to "Testing" (Brandon's own word for this)
 * rather than "Building", a verb nobody asked for. Every other domain reads
 * as "Working" — the deliberately simpler option — rather than reaching for
 * distinctions ("Searching", "Writing", …) the catalog doesn't structurally
 * encode as a small closed set.
 *
 * ── Why `run.state` alone can't say whether a run failed ────────────────────
 * `useActivity`'s `engine:done` listener calls `finish('done')` unconditionally
 * — it doesn't read the `PlanOutcome` it's handed, so a run with a failed step
 * still ends with `run.state === 'done'`. The real signal for "did anything
 * fail" is on the steps themselves, each of which carries its own state from
 * the executor's real `activity:step` events — so this reads `run.steps`,
 * not just `run.state`, for both the failed and the halted case (a halt that
 * lands after the last step had already finished leaves no step in the
 * `halted` state at all, only `run.state` itself).
 */

import { summarizeRun, type ActivityRun, type ActivityStep } from '@atlas/core';
import type { LatticePhase } from '@atlas/ui';

export interface LatticeStatus {
  phase: LatticePhase;
  verb: string;
  /** The current step's own label while running; the run's summary once it ends. */
  label?: string;
}

/** Domains whose own catalogued name is "Testing" in Brandon's vocabulary — see the module doc. */
const DOMAIN_VERB: Record<string, string> = {
  test: 'Testing',
  build: 'Testing',
};

function verbFor(step: ActivityStep | undefined): string {
  const domain = step?.skill?.split('.')[0];
  return (domain && DOMAIN_VERB[domain]) || 'Working';
}

/** The step to describe right now: the one still running, or the last one reported. */
function currentStep(run: ActivityRun): ActivityStep | undefined {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    if (run.steps[i]!.state === 'running') return run.steps[i];
  }
  return run.steps[run.steps.length - 1];
}

export function latticeStatusFor(run: ActivityRun | null | undefined): LatticeStatus {
  if (!run || run.steps.length === 0) return { phase: 'active', verb: 'Thinking', label: undefined };

  if (run.state === 'running') {
    const step = currentStep(run);
    return { phase: 'active', verb: verbFor(step), label: step?.label };
  }

  // Halted first: a stop can land after the last real step already finished,
  // leaving nothing in `run.steps` marked `halted` — `run.state` is the only
  // place that's recorded, so it's checked alongside the per-step signal.
  const halted = run.state === 'halted' || run.steps.some((s) => s.state === 'halted');
  if (halted) return { phase: 'halted', verb: 'Stopped', label: summarizeRun(run) };

  const failed = run.steps.some((s) => s.state === 'failed');
  if (failed) return { phase: 'error', verb: 'Error', label: summarizeRun(run) };

  return { phase: 'success', verb: 'Done', label: summarizeRun(run) };
}
