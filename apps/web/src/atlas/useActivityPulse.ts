/**
 * Lets Atlas count time spent USING it, as opposed to time it merely stays open.
 *
 * A deliberate input — a key, a click, a scroll — tells the native side "the person is here", at
 * most once every few seconds. The native side adds a slice of active time only while such a signal
 * is under a minute old and the window is on screen (`stats.rs`), so leaving Atlas in a corner
 * overnight counts as nothing. Mouse movement is not an input: a cursor resting on the window is not
 * a person using it. Nothing is sent but the fact that it happened.
 */

import { useEffect } from 'react';
import { isTauri, statsTouch } from '@atlas/platform';

/** At most one signal per this many milliseconds. */
export const PULSE_EVERY_MS = 5_000;

/** The events that count as use. */
export const PULSE_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;

/** A throttle that is easy to test: given the time of the last signal and now, may another go? */
export function shouldPulse(last: number, now: number): boolean {
  return last === 0 || now - last >= PULSE_EVERY_MS;
}

const defaultSend = () => void statsTouch();

export function useActivityPulse(send: () => void = defaultSend, enabled = isTauri()): void {
  useEffect(() => {
    if (!enabled) return;
    let last = 0;
    const onInput = () => {
      const now = Date.now();
      if (!shouldPulse(last, now)) return;
      last = now;
      send();
    };
    for (const e of PULSE_EVENTS) window.addEventListener(e, onInput, { passive: true, capture: true });
    return () => {
      for (const e of PULSE_EVENTS) window.removeEventListener(e, onInput, { capture: true });
    };
  }, [send, enabled]);
}
