/**
 * The light that runs around the composer while Atlas is working.
 *
 * ── Why this replaced the rotating conic gradient ──────────────────────────
 * The first version spun a conic gradient about the *centre* of the box. On a
 * bar this wide and this short that is the wrong geometry twice over:
 *  - the bright wedge only touches the border where its ray happens to cross
 *    it, so the light appeared in bursts on some edges and not others — it
 *    "cut off" instead of going all the way round;
 *  - equal angles are not equal distances along a 60:1 rectangle, so it raced
 *    along the short ends and dawdled along the long sides.
 *
 * This one travels along the border itself. Every layer is a stroke on the same
 * rounded-rectangle path, measured as `pathLength="100"` so an animation in
 * percent of the lap is a constant speed along the edge whatever the box's
 * size, and the light follows the corners instead of cutting across them.
 *
 * ── The four layers ─────────────────────────────────────────────────────────
 *   base   a faint complete ring, always there while working, so the edge reads
 *          as one continuous line even where the light is not
 *   bloom  a soft blurred wash, the glow
 *   tail   three progressively longer, dimmer strokes — the comet's trail, which
 *          fades in steps so its back end dissolves instead of stopping
 *   head   a short, bright stroke — the light itself
 * Each trailing layer is offset so its leading edge sits exactly on the
 * head's (see `tokens.css`), which is what makes it one thing rather than three.
 *
 * It fades in and out instead of appearing and disappearing, and pauses while
 * hidden. The geometry (`x`, `width`, `rx`…) is set in CSS so the ring tracks
 * the box's real size — the composer grows as you type.
 */
export function WorkingRing({ active }: { active: boolean }) {
  return (
    <svg
      aria-hidden="true"
      data-active={active}
      className="atlas-ring pointer-events-none absolute inset-0 h-full w-full overflow-visible"
    >
      <rect className="atlas-ring-base" />
      <rect className="atlas-ring-bloom" pathLength={100} />
      <rect className="atlas-ring-tail-far" pathLength={100} />
      <rect className="atlas-ring-tail-mid" pathLength={100} />
      <rect className="atlas-ring-tail-near" pathLength={100} />
      <rect className="atlas-ring-head" pathLength={100} />
    </svg>
  );
}
