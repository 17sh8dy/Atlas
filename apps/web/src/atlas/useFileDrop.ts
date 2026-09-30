/**
 * Files dragged in from outside Atlas — onto the chat bar, and only there.
 *
 * ── Why this is not `onDrop` ────────────────────────────────────────────────
 * In the desktop app the window itself receives an OS file drag, so the DOM's
 * `dragover`/`drop` never see it and hand back a `File` with no path anyway. A
 * path is the whole point — an attachment is a reference a skill can act on
 * (see `useAttachments`) — so the native drag events are used instead. They
 * arrive as window-relative positions, and this decides whether that position is
 * over the chat bar.
 *
 * ── Invisible until it matters ──────────────────────────────────────────────
 * Nothing is drawn until a file is actually being dragged *over the chat bar*.
 * `active` is false at all other times, so the overlay it drives is not in the
 * page at all — not hidden, absent.
 *
 * The decision itself (`dropDecision`) is a pure function, so what counts as
 * "over the chat bar", "leaving" and "dropped" is tested without a window.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { FileDragEvent } from '@atlas/core';

/** More than this in one drop is almost certainly a mistake, and slow to describe to the engine. */
export const MAX_DROPPED_FILES = 25;

export interface DropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DropState {
  /** Paths held from the drag's first event (later events carry only a position). */
  held: string[];
  /** A file is over the chat bar right now. */
  active: boolean;
}

export interface DropResult {
  state: DropState;
  /** Set only by a drop that landed on the chat bar. */
  dropped?: string[];
}

export const IDLE: DropState = { held: [], active: false };

function inside(rect: DropRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** What one native drag event does, given where the chat bar is. */
export function dropDecision(
  state: DropState,
  event: FileDragEvent,
  rect: DropRect | null,
): DropResult {
  if (event.phase === 'leave') return { state: IDLE };

  const held = event.paths.length ? event.paths : state.held;
  const over = rect !== null && inside(rect, event.x, event.y);

  if (event.phase === 'drop') {
    // A drop anywhere else does nothing here — and does not attach by accident.
    return over && held.length
      ? { state: IDLE, dropped: held.slice(0, MAX_DROPPED_FILES) }
      : { state: IDLE };
  }
  return { state: { held, active: over && held.length > 0 } };
}

export function useFileDrop(
  subscribe: ((handler: (event: FileDragEvent) => void) => Promise<() => void>) | undefined,
  target: RefObject<HTMLElement | null>,
  onFiles: (paths: string[]) => void,
): { active: boolean; count: number } {
  const [view, setView] = useState({ active: false, count: 0 });
  const state = useRef<DropState>(IDLE);
  const handler = useRef(onFiles);
  handler.current = onFiles;

  useEffect(() => {
    if (!subscribe) return;
    let alive = true;
    let stop: (() => void) | undefined;

    void subscribe((event) => {
      const box = target.current?.getBoundingClientRect() ?? null;
      const result = dropDecision(state.current, event, box);
      state.current = result.state;
      setView((was) =>
        was.active === result.state.active && was.count === result.state.held.length
          ? was
          : { active: result.state.active, count: result.state.held.length },
      );
      if (result.dropped?.length) handler.current(result.dropped);
    })
      .then((unlisten) => {
        if (alive) stop = unlisten;
        else unlisten();
      })
      .catch(() => {});

    return () => {
      alive = false;
      stop?.();
    };
  }, [subscribe, target]);

  return view;
}
