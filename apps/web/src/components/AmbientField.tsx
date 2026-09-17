/**
 * The room the voice screen happens in.
 *
 * Three layers, one canvas, one animation frame. Back to front: an aurora that
 * drifts, rings that leave the centre when you speak, and a field of dots that
 * quickens with the sound. None of them is decoration for its own sake — each
 * one carries a different part of "Atlas is here and listening", and together
 * they are what stops a single shape on a black rectangle from reading as a
 * screensaver.
 *
 * ── The aurora is drawn small and blown up, and that is the whole trick ─────
 * Soft coloured light is normally done with `filter: blur()` over big
 * elements, which is the most expensive thing a compositor can be asked for
 * and is exactly the effect that makes an app like this drop frames on a
 * laptop. It is also unnecessary. A blur is a low-pass filter, and so is
 * throwing away resolution: the aurora is rendered onto a ~160px offscreen
 * canvas and drawn back scaled up with smoothing on. The upscale *is* the
 * blur, it costs one GPU blit, and the fill cost is fixed no matter how large
 * the window gets — a maximised window pays exactly what a small one does.
 *
 * That last property is the reason this survives being full screen, which is
 * where the previous version of this file was weakest.
 *
 * ── The rings are the volume, and only the volume ───────────────────────────
 * They leave the centre when the sound crosses a threshold, so they are
 * emitted by speech rather than by a clock. Silence produces none. That makes
 * them readable as a signal: if rings are leaving the orb, something is being
 * heard. A ring animation on a timer would look identical and mean nothing.
 *
 * ── Still no React ──────────────────────────────────────────────────────────
 * Same reasoning as `VoiceOrb`. Ninety dots, six rings and four gradients
 * updated sixty times a second is a number of renders React should never be
 * asked to do, and none of it is interactive or belongs in the accessibility
 * tree.
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

/**
 * The offscreen the aurora is painted on, in pixels.
 *
 * Small enough that four overlapping radial gradients cost nothing, large
 * enough that the upscale reads as soft light rather than as visible blocks.
 * Below about 100 the banding shows as facets on the gradient edges; above
 * about 240 the fill cost stops being free and the extra detail is thrown
 * away by the smoothing anyway.
 */
const AURORA_W = 160;
const AURORA_H = 100;

/** How many blobs make up the aurora. */
const AURORA_BLOBS = 4;

/** Ceiling on rings alive at once, so a shout cannot flood the screen. */
const MAX_RINGS = 6;

/** Quietest level that may emit a ring. Below this it is room noise. */
const RING_THRESHOLD = 0.18;

/** Shortest gap between rings, in ms. Without it every loud frame emits one. */
const RING_INTERVAL = 220;

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
  /** Which aurora hue this dot is, as an index into the ramp. */
  hue: number;
}

interface Ring {
  /** Seconds since emission. */
  age: number;
  /** How loud it was when it left, which sets how far and bright it goes. */
  force: number;
}

interface Blob {
  /** Centre, in offscreen pixels, as the middle of its drift. */
  x: number;
  y: number;
  /** How far it wanders from that centre. */
  driftX: number;
  driftY: number;
  /** Radians per second, deliberately not shared between blobs. */
  speed: number;
  phase: number;
  radius: number;
  hue: number;
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

    // Read once per mount rather than per frame: `getComputedStyle` forces
    // style resolution, which is not something to do sixty times a second.
    const styles = getComputedStyle(document.documentElement);
    /** The aurora ramp, as "r, g, b" strings ready for `rgba()`. */
    const ramp = [1, 2, 3, 4, 5].map((n) => {
      const raw = styles.getPropertyValue(`--aurora-${n}`).trim();
      return (raw || '124 92 255').split(/[\s,]+/).slice(0, 3).join(', ');
    });
    const rgba = (hue: number, alpha: number) => `rgba(${ramp[hue % ramp.length]}, ${alpha})`;

    // The aurora's own canvas. Created once and reused every frame — an
    // offscreen allocated per frame would undo the whole saving.
    const sky = document.createElement('canvas');
    sky.width = AURORA_W;
    sky.height = AURORA_H;
    const skyCtx = sky.getContext('2d');
    if (!skyCtx) return;

    // Blobs live in offscreen coordinates, so they never need rebuilding when
    // the window resizes — only the blit target changes.
    const blobs: Blob[] = Array.from({ length: AURORA_BLOBS }, (_, i) => ({
      x: AURORA_W * (0.2 + Math.random() * 0.6),
      y: AURORA_H * (0.2 + Math.random() * 0.6),
      driftX: AURORA_W * (0.1 + Math.random() * 0.14),
      driftY: AURORA_H * (0.08 + Math.random() * 0.12),
      // Slow, and not multiples of each other, so the field never returns to
      // an arrangement the eye recognises.
      speed: 0.045 + i * 0.017 + Math.random() * 0.012,
      phase: Math.random() * Math.PI * 2,
      radius: AURORA_W * (0.3 + Math.random() * 0.22),
      // Skip a hue between blobs so adjacent ones are not near-identical.
      hue: (i * 2) % 5,
    }));

    let dots: Dot[] = [];
    const rings: Ring[] = [];
    let width = 0;
    let height = 0;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

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
      // Set after every resize, because resizing a canvas resets its context
      // state — and without this the aurora upscale is a grid of hard squares.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

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
        // Weighted towards the accent, so the field is mostly one colour with
        // occasional cooler dots rather than an even confetti of five.
        hue: Math.random() < 0.6 ? 0 : 1 + Math.floor(Math.random() * 4),
      }));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);

    let frame = 0;
    let smoothed = 0;
    /** Previous frame's level, so a *rise* can be told from a loud hold. */
    let previous = 0;
    let lastRing = 0;
    const started = performance.now();

    /**
     * Repaint the offscreen aurora.
     *
     * `globalCompositeOperation = 'lighter'` so overlapping blobs add up into
     * brighter light instead of the later one covering the earlier — the
     * difference between an aurora and four coloured discs.
     */
    const paintSky = (t: number, presence: number) => {
      skyCtx.clearRect(0, 0, AURORA_W, AURORA_H);
      skyCtx.globalCompositeOperation = 'lighter';
      for (const blob of blobs) {
        const angle = t * blob.speed + blob.phase;
        // Different multipliers on the two axes, so a blob travels an open
        // curve rather than a circle anyone can trace.
        const x = blob.x + Math.cos(angle) * blob.driftX;
        const y = blob.y + Math.sin(angle * 1.37) * blob.driftY;
        const gradient = skyCtx.createRadialGradient(x, y, 0, x, y, blob.radius);
        gradient.addColorStop(0, rgba(blob.hue, 0.5 * presence));
        gradient.addColorStop(0.5, rgba(blob.hue, 0.16 * presence));
        gradient.addColorStop(1, rgba(blob.hue, 0));
        skyCtx.fillStyle = gradient;
        skyCtx.fillRect(0, 0, AURORA_W, AURORA_H);
      }
      skyCtx.globalCompositeOperation = 'source-over';
    };

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const t = (now - started) / 1000;

      const raw = activeRef.current ? level() : 0;
      smoothed = raw > smoothed ? smoothed + (raw - smoothed) * 0.2 : smoothed * 0.94;

      // Dimmer when the microphone is closed — quiet enough to read as "off",
      // never zero, because a background that appears and disappears is a
      // flash rather than a state. Deliberately a wide gap from the active
      // figure now: the room should stay calm until Atlas is actually
      // listening or responding, and get more alive only then — not visually
      // busy by default before anything has happened.
      const presence = (activeRef.current ? 0.72 : 0.22) + smoothed * 0.4;

      ctx.clearRect(0, 0, width, height);

      // ── The aurora ────────────────────────────────────────────────────
      // Held well back. This is the light in the room, not a feature: at the
      // point where you look *at* it rather than past it, it has become a
      // second thing competing with the orb.
      paintSky(t, presence);
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.drawImage(sky, 0, 0, width, height);
      ctx.restore();

      // ── The rings ─────────────────────────────────────────────────────
      // Emitted on a *rise* past the threshold rather than on any loud frame,
      // so a held vowel sends one ring and not thirty.
      if (
        activeRef.current &&
        smoothed > RING_THRESHOLD &&
        smoothed > previous &&
        now - lastRing > RING_INTERVAL &&
        rings.length < MAX_RINGS
      ) {
        rings.push({ age: 0, force: smoothed });
        lastRing = now;
      }
      previous = smoothed;

      const centreX = width / 2;
      const centreY = height / 2;
      // Reach beyond the corners, so a ring leaves the screen rather than
      // stopping in open space where its disappearance is visible.
      const reach = Math.hypot(width, height) / 2;

      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i]!;
        // Seconds, from a fixed 60fps assumption rather than a measured delta.
        // This only sets how fast a ring expands: a dropped frame slowing one
        // fractionally is invisible, whereas delta maths that spikes on a
        // stall makes every live ring jump at once.
        ring.age += 1 / 60;
        const life = ring.age / 2.6;
        if (life >= 1) {
          rings.splice(i, 1);
          continue;
        }
        // Eases out: fast as it leaves the orb, slowing as it goes, which is
        // how a real disturbance in a medium behaves and so reads as physical.
        const radius = 120 + (reach - 120) * (1 - Math.pow(1 - life, 2.2));
        // Fades on a curve rather than linearly, so the tail is long and the
        // ring is never seen to blink out.
        const alpha = (1 - life) * (1 - life) * 0.28 * ring.force;
        ctx.beginPath();
        ctx.arc(centreX, centreY, radius, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(0, alpha);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // ── The dots ──────────────────────────────────────────────────────
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
        ctx.fillStyle = rgba(dot.hue, dot.alpha * breath * presence);
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
