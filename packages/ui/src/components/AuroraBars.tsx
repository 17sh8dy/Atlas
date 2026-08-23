/**
 * The waiting state, when waiting is the honest thing to show.
 *
 * ── Why bars and not a spinner ──────────────────────────────────────────────
 * A spinner says "something is happening" and nothing else. These say
 * "a reply is being written, and it will be about this long" — they occupy the
 * space the answer will occupy, so the transcript does not jump when the text
 * lands. That is the whole argument for skeletons, and it survives being made
 * prettier.
 *
 * ── Why they are not grey ───────────────────────────────────────────────────
 * A grey skeleton is a convention borrowed from pages that are *fetching*, and
 * it reads as a page that has not loaded. Atlas is not loading; it is
 * thinking. Colour that moves says that, and it is the one moment in the app
 * where colour moving is not decoration — it is the status.
 *
 * ── Two motions, one message ────────────────────────────────────────────────
 * The aurora runs *through* each bar and chases *around* its edge. The edge is
 * the part that keeps this from looking like a loading placeholder: a hairline
 * of moving colour around a dark body reads as something lit from within,
 * which is the register the rest of the app is in.
 *
 * Both animations are transform-only and defined in `tokens.css` — see the
 * long note there for why no keyframe here ever touches a colour, and why
 * that matters specifically while speech is being synthesised on the same
 * machine.
 */

import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';

export interface AuroraBarsProps {
  /**
   * How many bars. Three is the default because it is the shortest run that
   * reads as a paragraph rather than as a progress bar.
   */
  lines?: number;
  className?: string;
  /**
   * Announced to screen readers. The bars are decorative; this is the status.
   */
  label?: string;
}

/**
 * Descending widths, so the block reads as prose with a last line that stops
 * short — the shape a paragraph actually has. A stack of equal bars reads as a
 * table, and a table is not what is coming.
 */
const WIDTHS = ['96%', '88%', '62%', '74%', '48%'];

/**
 * Durations that do not divide into each other, so the bars never come back
 * into step. Three bars drifting at 2.6/3.1/2.2 seconds look like one live
 * surface; three bars at the same speed look like a striped image being
 * scrolled.
 */
const WAVE = [2.6, 3.1, 2.2, 2.9, 3.4];
const EDGE = [3.4, 4.3, 3.8, 4.7, 4.0];

export function AuroraBars({ lines = 3, className, label = 'Thinking' }: AuroraBarsProps) {
  const count = Math.max(1, Math.min(lines, WIDTHS.length));

  return (
    <div
      className={cn('flex w-full flex-col gap-2', className)}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          // `isolate` gives the bar its own stacking context, so the rotating
          // square inside it can never paint over a sibling if a parent ever
          // acquires a transform of its own.
          className="bg-surface-raised relative isolate h-2.5 overflow-hidden rounded-full"
          style={
            {
              width: WIDTHS[i],
              '--aurora-wave-duration': `${WAVE[i]}s`,
              '--aurora-edge-duration': `${EDGE[i]}s`,
              // Staggered starts, so the three bars are at different points in
              // their cycle on the very first frame. Without this they begin
              // in unison and only drift apart over several seconds, which is
              // exactly the period a person is most likely to be looking.
              animationDelay: `${i * -0.7}s`,
            } as CSSProperties
          }
        >
          {/* The chase around the perimeter. Sits under the body, which
              covers all of it but a hairline. */}
          <span className="atlas-aurora-edge" />

          {/* The body. Inset by a pixel on every side, which is what turns the
              square behind it into an outline rather than a background. Its
              own `overflow-hidden` clips the wave to the rounded shape. */}
          <span className="bg-surface absolute inset-px overflow-hidden rounded-full">
            {/* Held below full strength on purpose: at 1 the bar is a flat
                rainbow, which is loud and reads as a toy. At this weight the
                surface underneath still shows through and the colour looks
                like light passing behind glass — the same register as the
                voice screen. */}
            <span className="atlas-aurora-wave opacity-[0.55]" />
          </span>
        </div>
      ))}
    </div>
  );
}
