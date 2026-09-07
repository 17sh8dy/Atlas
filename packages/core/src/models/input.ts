/**
 * Synthetic mouse and keyboard input — the fallback layer for when nothing
 * more semantic can reach a control.
 *
 * Every shape here is deliberately narrow: a button is one of three strings,
 * a key is a name from a closed table, a hotkey is a short list of modifiers
 * plus one key. Nothing on this port accepts a raw code, because a raw code
 * is exactly the kind of thing that can't be reasoned about from the caller's
 * side of the boundary.
 */

export type MouseButton = 'left' | 'right' | 'middle';

export interface CursorPosition {
  x: number;
  y: number;
}
