/**
 * UI Automation — the tree of controls inside a window, and enough about
 * each one to act on it semantically instead of by screen coordinates.
 *
 * `path` is how an element is addressed: the sequence of child indices from
 * the window's root, the same way a filesystem path addresses a file. There
 * is deliberately no live handle anywhere in this model — a COM element
 * pointer cannot cross the IPC boundary, and holding one across two calls
 * would mean trusting nothing changed in the target app in between. Every
 * action method on `Platform` re-walks the path fresh and fails cleanly if
 * the tree no longer matches, rather than acting on whatever is there now.
 */

export interface UiaNode {
  /** Child indices from the window's root. Empty for the root itself. */
  path: number[];
  /** A human-readable role: "button", "edit", "menu item"… */
  role: string;
  name: string;
  automationId: string;
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  children: UiaNode[];
}
