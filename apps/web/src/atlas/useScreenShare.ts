/**
 * Sharing a screen with Atlas.
 *
 * ── What this actually is, stated plainly ───────────────────────────────────
 * There is no video pipeline on Windows here and this does not pretend to be
 * one. A share is a **repeated still capture** of one chosen target — a
 * monitor, a window, or the whole desktop — through the same `BitBlt` /
 * `PrintWindow` path `screen.capture` has always used. That is the honest
 * shape of what `screen.rs` can do, and it is enough for the thing this is
 * for: "look at this error", where the screen is not moving anyway.
 *
 * `INTERVAL_MS` is a second and a half. Fast enough that the preview tracks
 * what you are doing, slow enough that a GDI capture of a 4K desktop is not
 * running a core hot. It is not a frame rate and is not described as one.
 *
 * ── Consent is the feature ──────────────────────────────────────────────────
 * Nothing here starts on its own. A share begins only from an explicit choice
 * of an explicit target, the status bar is visible for as long as it runs, and
 * every control — stop, pause, switch — is the person's. Switching targets is
 * a new choice each time rather than a cycle, so Atlas can never end up
 * showing a screen nobody picked. `pause` stops capturing entirely rather than
 * freezing a preview over a live feed: a paused share that is still reading
 * the screen would be a lie told by a status bar.
 *
 * ── Where the frames go ─────────────────────────────────────────────────────
 * Into this hook's state, and nowhere else. Nothing in this build can
 * interpret an image — the intelligence port takes a string — so there is no
 * send path for a frame to travel down. The current frame can be *attached* to
 * a message, which makes it a referent for Atlas's own skills and puts it on
 * screen in the transcript; it is never uploaded. See `VisionContext` in
 * `@atlas/core` for the seam a local vision model would implement.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DisplayInfo, Platform, WindowEntry } from '@atlas/core';
import { toDataUrl } from './useAttachments';

/** Between captures. Not a frame rate — see this file's doc comment. */
const INTERVAL_MS = 1500;

export type ShareTargetKind = 'display' | 'window' | 'all';

export interface ShareTarget {
  kind: ShareTargetKind;
  /** Display index, or window id. Unused for `all`. */
  id?: string;
  /** What the status bar says is being shared. */
  label: string;
}

export interface ShareFrame {
  dataUrl: string;
  buffer: ArrayBuffer;
  at: number;
}

export interface ScreenShare {
  /** Null when nothing is being shared — the normal state. */
  target: ShareTarget | null;
  paused: boolean;
  /** The most recent capture, or null before the first one lands. */
  frame: ShareFrame | null;
  /** Set when a capture failed; the bar shows it rather than going quiet. */
  error: string | null;
  /** True when this build can share at all. */
  supported: boolean;
  start(target: ShareTarget): void;
  stop(): void;
  setPaused(paused: boolean): void;
  /** The monitors and windows available to share, read when the picker opens. */
  listTargets(): Promise<{ displays: DisplayInfo[]; windows: WindowEntry[] }>;
}

export function useScreenShare(platform: Platform): ScreenShare {
  const [target, setTarget] = useState<ShareTarget | null>(null);
  const [paused, setPausedState] = useState(false);
  const [frame, setFrame] = useState<ShareFrame | null>(null);
  const [error, setError] = useState<string | null>(null);

  const supported = Boolean(platform.captureScreen);

  // Read inside the interval so a target switch takes effect on the next
  // capture without tearing down and rebuilding the timer.
  const targetRef = useRef<ShareTarget | null>(null);
  targetRef.current = target;
  const inFlight = useRef(false);

  const capture = useCallback(
    async (of: ShareTarget): Promise<ArrayBuffer | null> => {
      if (of.kind === 'window' && of.id) return (await platform.captureWindow?.(of.id)) ?? null;
      if (of.kind === 'display' && of.id !== undefined && platform.captureDisplay) {
        return (await platform.captureDisplay(Number(of.id))) ?? null;
      }
      return (await platform.captureScreen?.()) ?? null;
    },
    [platform],
  );

  useEffect(() => {
    if (!target || paused) return;
    let alive = true;

    const tick = async () => {
      const of = targetRef.current;
      // Skipped rather than queued: on a slow capture, stacking timers would
      // put the machine further behind with every tick.
      if (!of || inFlight.current || !alive) return;
      inFlight.current = true;
      try {
        const buffer = await capture(of);
        if (!alive) return;
        if (!buffer) {
          setError("That target couldn't be captured.");
          return;
        }
        setError(null);
        setFrame({ dataUrl: toDataUrl(buffer), buffer, at: Date.now() });
      } catch (e) {
        if (alive) {
          // A window that has closed is the common case, and it is the one
          // worth stopping for rather than retrying twice a second forever.
          const reason = String(e instanceof Error ? e.message : e);
          setError(reason);
          if (targetRef.current?.kind === 'window') {
            setTarget(null);
          }
        }
      } finally {
        inFlight.current = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [target, paused, capture]);

  const start = useCallback((next: ShareTarget) => {
    setTarget(next);
    setPausedState(false);
    // The old target's last frame must not linger under the new one's label —
    // for a second and a half the bar would name one screen and show another.
    setFrame(null);
    setError(null);
  }, []);

  const stop = useCallback(() => {
    setTarget(null);
    setPausedState(false);
    setFrame(null);
    setError(null);
  }, []);

  const listTargets = useCallback(async () => {
    const [displays, windows] = await Promise.all([
      platform.listDisplays?.().catch(() => []) ?? Promise.resolve([]),
      platform.listWindows?.().catch(() => []) ?? Promise.resolve([]),
    ]);
    return { displays: displays ?? [], windows: windows ?? [] };
  }, [platform]);

  return {
    target,
    paused,
    frame,
    error,
    supported,
    start,
    stop,
    setPaused: setPausedState,
    listTargets,
  };
}
