/**
 * Windows other than Atlas's own — what's open on the desktop, and enough
 * about each one to focus, move, resize or close it.
 *
 * Read-only fields describe what a window *is*; the four action methods on
 * `Platform` are what changes one. Kept as one model rather than split the
 * way `service.ts` splits entry/detail — there's no separate "detail" call
 * here, since `WindowEntry` already carries everything `list`, `focus` and
 * `close` all need.
 */

export interface WindowEntry {
  /**
   * Opaque, and only ever valid for the moment it was read. A window can
   * close between one call and the next, so every method taking an `id`
   * re-resolves it and fails cleanly rather than assuming it still exists.
   */
  id: string;
  title: string;
  className: string;
  processName: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
  /** True for the one window `activeWindow()` would also return. */
  active: boolean;
}
