/**
 * The quiet thing behind Home.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * Atlas is the "Navigator Engine", and Home is the one screen where that
 * identity has room to say anything. A faint field of threads reads as a
 * network being traced — which is what the engine actually does — and it is
 * the only decoration in the app that is not also information.
 *
 * ── The rules it lives under ────────────────────────────────────────────────
 * `tokens.css` states that the aurora loading state is "the only place in the
 * app where colour moves on its own". This is the second, and it is deliberately
 * held to a standard the first does not need:
 *
 *   * **It cannot be interacted with.** `pointer-events: none` and
 *     `aria-hidden`, so it is invisible to the mouse, to text selection and to
 *     a screen reader. Nothing on Home changes its hit target because of this.
 *   * **It stops when nobody is looking.** Atlas is summoned by a keystroke and
 *     spends most of its life hidden. A WebGL context running a full-screen
 *     fragment shader against a hidden window is pure waste, so the effect is
 *     *unmounted* — not merely paused — whenever the document is hidden, which
 *     releases the context and the animation frame with it.
 *   * **It respects `prefers-reduced-motion`.** Not by slowing down: by not
 *     existing. The setting means "do not move things", and a slower drift is
 *     still a moving thing.
 *   * **It only exists on Home.** Mounted by Home's empty state, so it is gone
 *     the moment a conversation starts. A backdrop behind a wall of text is
 *     noise; behind an empty screen it is atmosphere.
 *
 * ── Why it is turned down this far ──────────────────────────────────────────
 * The defaults that ship with the component are built to be seen on a demo
 * page. Here the opposite is wanted: something you notice only if you look for
 * it, and never while reading. Hence a low `opacity`, a `speed` well under the
 * default, and colours pulled from Atlas's own accent rather than the
 * component's pink — the palette stays purple-on-black, and the effect
 * disappears into it rather than sitting on top.
 *
 * ── Why the shader is a separate chunk ──────────────────────────────────────
 * Imported statically, `ogl` and the shader landed in the entry bundle: every
 * launch paid ~17 KB gzipped to parse a WebGL library, including the launches
 * that go straight to a conversation, and the ones under `prefers-reduced-motion`
 * where the effect never renders at all. That is the wrong trade for an app
 * whose argument is that it starts instantly.
 *
 * `lazy` moves it into its own chunk, requested the first time this component
 * actually decides to render something. The gates below run *before* the
 * import is reached, so a reduced-motion machine never downloads the shader at
 * all — the saving is not just deferred there, it is total.
 *
 * The `Suspense` fallback is `null` rather than a placeholder: this is a
 * background, and a background that flashes a loading state on the way in
 * would be more noticeable than the effect it is loading.
 */

import { lazy, Suspense, useEffect, useState } from 'react';

const WebThreads = lazy(() => import('./vendor/WebThreads'));

/** Atlas's `--color-primary`, as the shader wants it. */
const ACCENT = '#7858FB';
/** A cooler companion so the threads are not one flat hue. */
const ACCENT_COOL = '#5885FF';

/**
 * True while the window is actually on screen.
 *
 * `visibilitychange` covers minimise, another window taking over, and Atlas
 * being dismissed to the tray — every case where the shader would otherwise
 * keep drawing frames nobody sees.
 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}

/**
 * True when the person has asked for less motion.
 *
 * Watched rather than read once: the setting can change while the app is open,
 * and an effect that only checks at mount would keep moving until a restart.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export function HomeBackdrop() {
  const visible = useDocumentVisible();
  const reduced = usePrefersReducedMotion();

  // Both are hard gates rather than adjustments: nothing renders, so there is
  // no canvas, no WebGL context and no animation frame.
  if (reduced || !visible) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      // Behind everything Home draws. The content sits in a `relative z-10`
      // sibling, so this cannot come forward however the layout changes.
      style={{ zIndex: 0 }}
    >
      {/*
        The component fills its container and takes the mouse itself unless
        told not to; `mouseInteraction` is off because a background that
        reacts to the cursor is a background asking to be noticed.
      */}
      <Suspense fallback={null}>
        <WebThreads
          color1={ACCENT}
          color2={ACCENT_COOL}
          color3={ACCENT}
          speed={0.06}
          threadCount={5}
          spread={0.22}
          thickness={0.9}
          brightness={0.42}
          opacity={0.28}
          glow={0.015}
          grain={false}
          shimmer={false}
          mouseInteraction={false}
          className="h-full w-full"
        />
      </Suspense>
      {/*
        A vignette that keeps the threads away from the middle, where the
        greeting and the cards are. The effect is strongest at the edges and
        effectively absent behind text, which is what makes it safe to read
        over without lowering the opacity so far that it vanishes entirely.
      */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 50% 45%, rgb(var(--color-background)) 30%, transparent 100%)',
        }}
      />
    </div>
  );
}
