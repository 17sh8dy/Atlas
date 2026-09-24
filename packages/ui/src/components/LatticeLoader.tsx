/**
 * The inline "Atlas is doing something" indicator — a small NxN lattice that
 * brightens in a phase-offset wave beside a verb, resolving to a check or a
 * cross when the caller says the task has ended.
 *
 * ── What this component is not ──────────────────────────────────────────────
 * It does not know what a plan is, what an activity step is, or what Atlas is
 * actually doing. It takes a `phase`, a `verb` and an optional `label` —
 * three strings and an enum — and draws them. The mapping from a real
 * `ActivityRun` to those three values lives in `apps/web`'s
 * `lattice-status.ts`, on the other side of the same boundary `AuroraBars`
 * and `ActivityPanel` already draw: this package renders, the app decides
 * what there is to render. That boundary is also what makes the privacy rule
 * structural rather than a convention — there is no field here a reasoning
 * trace could be threaded through even by mistake, because nothing here reads
 * from an engine, a model, or a bus. It only ever receives the same short,
 * human-authored strings `AuroraBars`' `label` prop and `ActivityPanel`'s
 * `StepRow` already display.
 *
 * ── Colour: the accent, not the aurora ──────────────────────────────────────
 * The aurora's five-hue ramp is reserved for "a reply is arriving" (see
 * `AuroraBars`'s own doc comment) — the one moment colour moving is the
 * message. A lattice means something else: work is happening, the same
 * register the composer's working ring already uses for "Atlas is
 * doing something" with a single accent colour. Reusing that register here
 * rather than the aurora's keeps the two moments visually distinct.
 *
 * ── Motion: opacity and scale only ──────────────────────────────────────────
 * Same reasoning as the aurora's wave and edge: both are compositor
 * properties, so the wave never touches layout or paint, and reduced motion
 * turns it off entirely via the same `@media` rule in `tokens.css` — see
 * `.atlas-lattice-cell`.
 */

import type { CSSProperties } from 'react';
import { Check, X } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * `active` keeps the cells brightening. The other three are a resolution —
 * a real one, decided by the caller from a real outcome — and each renders a
 * fixed glyph instead of the wave.
 */
export type LatticePhase = 'active' | 'success' | 'error' | 'halted';

export interface LatticeLoaderProps {
  phase: LatticePhase;
  /** The short verb — "Thinking", "Working", "Testing", "Done" — never raw model output. */
  verb: string;
  /** The current step's own human-authored label, or the run's summary once it ends. */
  label?: string;
  /** Already formatted by the caller (see `formatLive`) — no clock or formatter lives here. */
  elapsed?: string;
  /**
   * Cells per side. The reference pattern is "a 3x3 or 4x4 lattice"; 4 is the
   * default because it reads as a grid rather than a plus-sign at this size.
   */
  size?: 3 | 4;
  className?: string;
}

const RESOLVED: Record<Exclude<LatticePhase, 'active'>, { className: string; Glyph: typeof Check }> = {
  success: { className: 'text-success', Glyph: Check },
  error: { className: 'text-danger', Glyph: X },
  halted: { className: 'text-danger', Glyph: X },
};

export function LatticeLoader({
  phase,
  verb,
  label,
  elapsed,
  size = 4,
  className,
}: LatticeLoaderProps) {
  const statusText = [verb, label].filter(Boolean).join(' — ') || verb;

  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {/* Fixed footprint regardless of what's inside, so resolving from the
          grid to a glyph never reflows the verb next to it. */}
      <span aria-hidden="true" className="grid h-[23px] w-[23px] shrink-0 place-items-center">
        {phase === 'active' ? <Grid size={size} /> : <Resolved phase={phase} />}
      </span>

      {/*
       * Announced once per real change of what Atlas is doing — `statusText`
       * only changes when `verb`/`label` do, which is on the order of once
       * per step, not once per tick. The clock is a second, separate region
       * on purpose: `role="timer"` alone (no `aria-live`) is not announced on
       * every update the way this one is, so a number changing ten times a
       * second next to it can never turn into ten announcements a second —
       * see `Transcript.tsx`'s old `LiveTimer`, which kept the same split.
       */}
      <span className="flex min-w-0 items-baseline gap-1.5 text-xs">
        <span
          role="status"
          aria-live="polite"
          aria-label={statusText}
          className={cn(phase === 'active' ? 'text-foreground' : RESOLVED[phase].className)}
        >
          {verb}
        </span>
        {label && (
          <span aria-hidden="true" className="text-foreground-subtle min-w-0 truncate">
            — {label}
          </span>
        )}
        {elapsed && (
          <span
            role="timer"
            aria-label="Time spent so far"
            className="text-foreground-subtle shrink-0 tabular-nums"
          >
            {elapsed}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The wave. Negative delays (the same trick `AuroraBars` uses) so every cell
 * is already mid-cycle on the first frame, and the delay is a function of a
 * cell's row+column — a diagonal ripple rather than every cell moving in
 * lockstep or in a plain left-to-right scan.
 */
function Grid({ size }: { size: 3 | 4 }) {
  const cells = size * size;
  return (
    <span
      className="grid gap-[2px]"
      style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: cells }, (_, i) => {
        const row = Math.floor(i / size);
        const col = i % size;
        return (
          <span
            key={i}
            className="atlas-lattice-cell bg-primary h-1 w-1 rounded-[1.5px]"
            style={{ animationDelay: `${-(row + col) * 0.12}s` } as CSSProperties}
          />
        );
      })}
    </span>
  );
}

/** The resolution: a fixed glyph. Its footprint is the wrapper's, not its own. */
function Resolved({ phase }: { phase: Exclude<LatticePhase, 'active'> }) {
  const { className, Glyph } = RESOLVED[phase];
  return <Glyph className={cn('h-4 w-4', className)} strokeWidth={2.5} />;
}
