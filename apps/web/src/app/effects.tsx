/**
 * Enhanced Effects — an optional layer of lift, glow and a cursor-tracked
 * highlight on interactive surfaces. Off by default; the standard interface
 * is already finished without it.
 *
 * ── Why this exists as its own provider, next to `theme.tsx` rather than in
 *    it ──────────────────────────────────────────────────────────────────
 * Theme is *what Atlas looks like*; this is *how much it moves*. Keeping them
 * separate means turning Enhanced Effects on or off can never touch a colour,
 * and switching theme can never touch motion — two independent axes, two
 * independent settings.
 *
 * ── The reduced-motion rule ──────────────────────────────────────────────
 * The setting a person chose and whether the effect is *active* are two
 * different things. Turning Enhanced Effects on is remembered even if the OS
 * is (or later becomes) set to `prefers-reduced-motion: reduce` — this never
 * silently flips the toggle off — but nothing actually moves while that's
 * true: `document.documentElement.dataset.effects` only ever becomes
 * `'enhanced'` when both the setting is on AND reduced motion is off, and
 * `styles/index.css`'s rules key on exactly that attribute. `--duration-fast`
 * collapsing to 0ms under the same media query (tokens.css) is the second,
 * independent line of defence.
 *
 * ── Why the pointer tracking is a single delegated listener ─────────────
 * One `pointermove` listener on `document`, gated to mount only while the
 * effect is active, rAF-throttled, and touching only the element the pointer
 * is actually over (`.closest('.atlas-enhance')`). No per-element listeners,
 * no work at all while the effect is off or the pointer is elsewhere — see
 * `styles/index.css` for what `--glow-x`/`--glow-y` do with these values.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'atlas.effects.enhanced';

interface EffectsContextValue {
  /** The user's stored preference, independent of whether it's currently active. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** `enabled && !reducedMotion` — what Settings should show as "currently on". */
  active: boolean;
}

const EffectsContext = createContext<EffectsContextValue | null>(null);

function readStored(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

function readReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function EffectsProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState<boolean>(readStored);
  const [reducedMotion, setReducedMotion] = useState<boolean>(readReducedMotion);
  const active = enabled && !reducedMotion;

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.effects = active ? 'enhanced' : 'plain';
  }, [active]);

  const setEnabled = (next: boolean) => {
    setEnabledState(next);
    localStorage.setItem(STORAGE_KEY, String(next));
  };

  useCursorGlow(active);

  const value = useMemo<EffectsContextValue>(
    () => ({ enabled, setEnabled, active }),
    [enabled, active],
  );

  return <EffectsContext.Provider value={value}>{children}</EffectsContext.Provider>;
}

export function useEnhancedEffects(): EffectsContextValue {
  const ctx = useContext(EffectsContext);
  if (!ctx) throw new Error('useEnhancedEffects must be used within an EffectsProvider');
  return ctx;
}

/**
 * Writes `--glow-x`/`--glow-y` (in pixels, relative to the hovered element)
 * onto whichever `.atlas-enhance` surface the pointer is currently over.
 * `styles/index.css` reads them as the centre of a radial highlight.
 *
 * Mounted and unmounted with `active` rather than checking it inside the
 * handler, so the listener itself doesn't exist — not just does nothing —
 * the moment the effect is off.
 */
function useCursorGlow(active: boolean): void {
  const frame = useRef(0);

  useEffect(() => {
    if (!active) return;

    const onMove = (e: PointerEvent) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('.atlas-enhance');
      if (!target) return;
      if (frame.current) return; // one pending write per frame, never a queue
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const rect = target.getBoundingClientRect();
        target.style.setProperty('--glow-x', `${e.clientX - rect.left}px`);
        target.style.setProperty('--glow-y', `${e.clientY - rect.top}px`);
      });
    };

    document.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onMove);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [active]);
}
