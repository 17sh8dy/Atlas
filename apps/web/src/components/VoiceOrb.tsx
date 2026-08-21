/**
 * The thing that looks like Atlas is listening.
 *
 * ── Why canvas, and not the obvious alternatives ────────────────────────────
 * Three.js with a shader is the usual answer for this look, and it is the
 * wrong tool at this size: ~600 KB and a WebGL context to move a shape 240
 * pixels across, in an app whose whole argument is that it is small. A
 * fragment shader earns its place when the *pixels* have to move — liquid,
 * plasma, a hologram. Here the outline moves, which is a path, which is what a
 * 2D canvas is for.
 *
 * Framer Motion is the wrong tool for a different reason: it animates by
 * driving React state, and this has to update sixty times a second from audio.
 * Sixty renders a second of a screen that is otherwise still is a cost paid to
 * move one circle. Everything here runs in one `requestAnimationFrame` loop
 * that React never sees.
 *
 * ── The shape is a blob, not a circle ───────────────────────────────────────
 * A circle that scales is a volume meter — it says "loud" and nothing else,
 * and it says it identically for a vowel and for a door slamming. This
 * displaces the outline per angle from the *frequency bands*, so a shape held
 * on "ahh" is visibly a different shape from one on "sss". That is what reads
 * as alive rather than as instrumentation.
 *
 * Displacement is a sum of harmonics rather than a noise texture: three sine
 * terms at frequencies that do not divide into each other never repeat
 * visibly, cost nothing, and — unlike sampled noise — are continuous around
 * the circle by construction, so the path closes without a seam.
 *
 * ── Every phase has motion, and each one means something ────────────────────
 * A still screen and a broken one look the same. Idle breathes slowly;
 * thinking sweeps an arc, which is the one state where the motion is not
 * driven by sound and so must obviously not be; speaking and hearing follow
 * the audio and differ only in whose it is.
 */

import { useEffect, useRef } from 'react';

export type OrbPhase = 'off' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking';

interface Props {
  phase: OrbPhase;
  /** Fills the caller's array with per-band amplitude. Read every frame. */
  bands(out: Float32Array): void;
  /** Overall amplitude, 0–1. Read every frame. */
  level(): number;
  /** Rendered size in CSS pixels. */
  size?: number;
}

/**
 * Bands around the circumference.
 *
 * Ten is enough that a vowel and a sibilant produce different shapes, and few
 * enough that each one is a visible lobe rather than a ripple. The set is
 * mirrored across the vertical, so the shape stays symmetrical — an asymmetric
 * blob reads as a lopsided circle rather than as a considered form.
 */
const BAND_COUNT = 10;

export function VoiceOrb({ phase, bands, level, size = 240 }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The phase is read inside the animation loop rather than closed over, so a
  // change of state does not restart the loop and lose its accumulated motion.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;

    // Backing store at device resolution; the element stays `size` CSS pixels.
    // Without this the outline is soft on exactly the displays people notice
    // softness on.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    element.width = size * dpr;
    element.height = size * dpr;
    ctx.scale(dpr, dpr);

    // Read once per mount rather than per frame: `getComputedStyle` forces
    // style resolution, which is not something to do sixty times a second.
    const styles = getComputedStyle(document.documentElement);
    const accent = (styles.getPropertyValue('--color-primary').trim() || '124 92 255')
      .split(/[\s,]+/)
      .slice(0, 3)
      .join(', ');
    const rgba = (alpha: number) => `rgba(${accent}, ${alpha})`;

    const raw = new Float32Array(BAND_COUNT);
    const smoothed = new Float32Array(BAND_COUNT);
    let smoothedLevel = 0;
    let start = performance.now();
    let frame = 0;

    const centre = size / 2;
    // Room is left for the outline to grow into: a blob that can reach the
    // edge of its canvas gets clipped on exactly the loud syllables it is
    // there to show.
    const base = size * 0.27;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const t = (now - start) / 1000;
      const current = phaseRef.current;
      const live = current === 'speaking' || current === 'hearing' || current === 'listening';

      ctx.clearRect(0, 0, size, size);

      if (live) bands(raw);
      else raw.fill(0);

      // Rises quickly and falls slowly, the way a level meter does: following
      // a syllable up and settling after it, rather than buzzing on every
      // frame the analyser happens to disagree with itself.
      for (let i = 0; i < BAND_COUNT; i++) {
        const next = raw[i]!;
        smoothed[i] =
          next > smoothed[i]!
            ? smoothed[i]! + (next - smoothed[i]!) * 0.45
            : smoothed[i]! * 0.88;
      }
      const nextLevel = live ? level() : 0;
      smoothedLevel =
        nextLevel > smoothedLevel
          ? smoothedLevel + (nextLevel - smoothedLevel) * 0.45
          : smoothedLevel * 0.9;

      // Idle breath. Present in every phase, not only when silent — it is what
      // keeps the shape from ever being perfectly still, which is the only
      // state indistinguishable from a frozen frame.
      const breath = 1 + Math.sin(t * 1.8) * 0.035;
      const swell = current === 'off' ? 0.88 : 1;
      const radius = base * breath * swell * (1 + smoothedLevel * 0.22);

      // Two more outlines behind the first, larger and fainter and slightly
      // behind in time, which reads as depth rather than as three shapes.
      drawBlob(ctx, centre, radius * 1.22, t * 0.7, smoothed, 0.55, rgba(0.07));
      drawBlob(ctx, centre, radius * 1.1, t * 0.85, smoothed, 0.75, rgba(0.1));

      const fill = ctx.createRadialGradient(centre, centre, radius * 0.2, centre, centre, radius);
      fill.addColorStop(0, rgba(current === 'off' ? 0.16 : 0.42));
      fill.addColorStop(1, rgba(current === 'off' ? 0.06 : 0.16));
      drawBlob(ctx, centre, radius, t, smoothed, 1, fill);

      if (current === 'thinking' || current === 'transcribing') {
        // The one state whose motion is not the audio's, and it has to look
        // that way: a sweep, obviously mechanical, obviously waiting.
        ctx.save();
        ctx.strokeStyle = rgba(0.7);
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        const from = t * 2.4;
        ctx.arc(centre, centre, radius * 1.3, from, from + Math.PI * 0.45);
        ctx.stroke();
        ctx.restore();
      }
    };

    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      start = performance.now();
    };
  }, [bands, level, size]);

  return (
    <canvas
      ref={canvas}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/**
 * One closed outline, displaced per angle.
 *
 * The band index is mirrored across the vertical so the left and right sides
 * match and, more importantly, so the first and last sample agree — a path
 * whose ends disagree has a visible crease no amount of smoothing hides.
 */
function drawBlob(
  ctx: CanvasRenderingContext2D,
  centre: number,
  radius: number,
  t: number,
  bands: Float32Array,
  reach: number,
  fill: string | CanvasGradient,
) {
  const steps = 120;
  ctx.beginPath();

  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;

    // Mirrored, and interpolated between neighbours rather than stepped, so
    // the lobes are hills instead of facets.
    const position = (Math.abs(((angle / Math.PI) % 2) - 1) * (bands.length - 1)) as number;
    const low = Math.floor(position);
    const high = Math.min(bands.length - 1, low + 1);
    const blend = position - low;
    const energy = bands[low]! * (1 - blend) + bands[high]! * blend;

    // Frequencies chosen not to be multiples of each other, so the sum has no
    // period short enough for an eye to catch.
    const wobble =
      Math.sin(angle * 3 + t * 1.1) * 0.018 +
      Math.sin(angle * 5 - t * 0.7) * 0.012 +
      Math.sin(angle * 7 + t * 1.6) * 0.008;

    const r = radius * (1 + wobble + energy * 0.26 * reach);
    const x = centre + Math.cos(angle) * r;
    const y = centre + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
