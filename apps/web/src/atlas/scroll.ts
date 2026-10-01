/**
 * How fast the conversation scrolls.
 *
 * A mouse wheel notch is ~100px and a free-spinning or high-resolution wheel can send
 * far more, which in a long conversation flings you past what you were reading. This
 * scales every wheel step by a percentage and caps how far one step may go, so
 * scrolling stays controllable however long the thread is.
 *
 * Only the wheel is touched: keyboard scrolling, the scrollbar and touch are left to
 * the browser. At 100% with an ordinary wheel nothing changes at all.
 *
 * Storage key is lowercase (storage.rs refuses anything else).
 */

import type { Storage } from '@atlas/core';

export interface ScrollSettings {
  /** Percent of normal speed. */
  speed: number;
}

export const SCROLL_MIN = 25;
export const SCROLL_MAX = 200;
export const DEFAULT_SCROLL: ScrollSettings = { speed: 100 };
export const SCROLL_KEY = 'atlas.settings.scroll';
export const SCROLL_CHANGED = 'atlas:scroll-changed';

/** The most one wheel event may move, at 100%. Bigger flings are cut to this. */
export const MAX_STEP_PX = 160;
const LINE_PX = 40;

export function cleanScroll(raw: unknown): ScrollSettings {
  const speed = (raw as Partial<ScrollSettings> | null | undefined)?.speed;
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return DEFAULT_SCROLL;
  return { speed: Math.min(SCROLL_MAX, Math.max(SCROLL_MIN, Math.round(speed))) };
}

export async function readScroll(storage: Storage): Promise<ScrollSettings> {
  try {
    return cleanScroll(await storage.get(SCROLL_KEY));
  } catch {
    return DEFAULT_SCROLL;
  }
}

export async function writeScroll(storage: Storage, next: ScrollSettings): Promise<void> {
  const clean = cleanScroll(next);
  await storage.set(SCROLL_KEY, clean);
  try {
    window.dispatchEvent(new CustomEvent(SCROLL_CHANGED, { detail: clean }));
  } catch {
    /* not in a browser (tests) */
  }
}

/**
 * Pixels to scroll for one wheel event: line / page deltas converted to pixels, scaled
 * by the setting, then capped at `MAX_STEP_PX` scaled the same way.
 */
export function wheelStep(deltaY: number, deltaMode: number, speed: number, pageHeight: number): number {
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * pageHeight : deltaY;
  const factor = speed / 100;
  const cap = MAX_STEP_PX * factor;
  const scaled = px * factor;
  return Math.max(-cap, Math.min(cap, scaled));
}
