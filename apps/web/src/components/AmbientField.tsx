/**
 * The quiet motion behind the voice screen.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 * The voice screen is one shape in the middle of a lot of nothing, and at full
 * screen the nothing wins. This fills the space without competing: slow drift,
 * low contrast, no edges. It is deliberately not "particles" in the demo sense
 * — nothing here orbits, collides, or draws lines between itself, because all
 * of those pull the eye toward the corners and away from the thing that
 * matters.
 *
 * ── It is still tied to the audio ───────────────────────────────────────────
 * The field brightens and drifts fractionally faster while there is sound, so
 * it belongs to the same moment as the orb rather than running on its own
 * clock beside it. Subtle on purpose: at the point where you *notice* the
 * background reacting, it has become a second thing to watch.
 *
 * ── Canvas, one loop, no React ──────────────────────────────────────────────
 * Same reasoning as `VoiceOrb`. Forty dots at sixty frames a second is forty
 * React elements being reconciled sixty times a second if this were done with
 * elements, and it buys nothing — none of them is interactive, and none of
 * them needs to be in the accessibility tree.
 */

import { useEffect, useRef } from 'react';

interface Props {
  /** Live 0-1 amplitude. Read every frame, never rendered. */
  level(): number;
  /** Dimmed, but still clearly present, when the microphone is closed. */
  active: boolean;
}

/**
 * Enough to read as a field, few enough to stay out of the way.
 *
 * Scaled by area rather than fixed, so a maximised window is not sparser than
 * a small one — the complaint that prompted this was specifically about full
 * screen.
 */
const DENSITY = 1 / 22000;
const MAX_DOTS = 90;

interface Dot {
  x: number;
  y: number;
  /** Fractions of a pixel per frame. */
  dx: number;
  dy: number;
  radius: number;
  alpha: number;
  /** Offsets each dot's breathing so the field never pulses in unison. */
  phase: number;
}

export function AmbientField({ level, active }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const element = canvas.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const styles = getComputedStyle(document.documentElement);
    const accent = (styles.getPropertyValue('--color-primary').trim() || '124 92 255')
      .split(/[\s,]+/)
      .slice(0, 3)
      .join(', ');

    let dots: Dot[] = [];
    let width = 0;
    let height = 0;

    /**
     * Rebuild for a new size.
     *
     * Positions are regenerated rather than rescaled: a rescaled field
     * stretches, and a stretched field is visibly a stretched field.
     */
    const measure = () => {
      const rect = parent.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      element.width = width * dpr;
      element.height = height * dpr;
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(MAX_DOTS, Math.round(width * height * DENSITY));
      dots = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        // Slow, and never axis-aligned — a field where everything drifts the
        // same way reads as a scrolling background.
        dx: (Math.random() - 0.5) * 0.16,
        dy: (Math.random() - 0.5) * 0.16,
        radius: 0.6 + Math.random() * 1.7,
        alpha: 0.09 + Math.random() * 0.26,
        phase: Math.random() * Math.PI * 2,
      }));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);

    let frame = 0;
    let smoothed = 0;
    const started = performance.now();

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const t = (now - started) / 1000;

      const raw = activeRef.current ? level() : 0;
      smoothed = raw > smoothed ? smoothed + (raw - smoothed) * 0.2 : smoothed * 0.94;

      // Dimmer when the microphone is closed, but not much — and never
      // absent, because a background that appears and disappears is a flash.
      // The idle figure sits close to the live one deliberately.
      // The complaint this answers was about the screen looking empty *before*
      // anything is happening, and a field you can only see once you are
      // already talking does not answer it.
      const presence = (activeRef.current ? 0.7 : 0.5) + smoothed * 0.4;

      ctx.clearRect(0, 0, width, height);
      for (const dot of dots) {
        dot.x += dot.dx * (1 + smoothed * 0.8);
        dot.y += dot.dy * (1 + smoothed * 0.8);

        // Wrap with a margin, so a dot fades out past the edge instead of
        // reappearing instantly against it.
        if (dot.x < -8) dot.x = width + 8;
        if (dot.x > width + 8) dot.x = -8;
        if (dot.y < -8) dot.y = height + 8;
        if (dot.y > height + 8) dot.y = -8;

        const breath = 0.75 + Math.sin(t * 0.6 + dot.phase) * 0.25;
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, dot.radius * (1 + smoothed * 0.35), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${accent}, ${dot.alpha * breath * presence})`;
        ctx.fill();
      }
    };

    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [level]);

  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
