/**
 * Emergency stop — the domain half.
 *
 * The stop itself does not live here, or anywhere in TypeScript. It lives in
 * the desktop shell (`halt.rs`), below the engine, the planner and the model,
 * because a stop routed through any of those is a *request* handled by the
 * machinery you are trying to stop. What lives here is what every layer above
 * needs to agree on:
 *
 *  - the stop key's rules, so Settings can explain a refusal as it is typed
 *    (Rust checks them again — the renderer is not the security boundary);
 *  - `HALTED_PREFIX`, how a refusal from a latched hand command is recognised;
 *  - `untilHalted`, the one way the engine waits on anything a halt must be
 *    able to cut short.
 */

export const DEFAULT_HALT_SHORTCUT = 'F8';

/** The opening words of `halt.rs`'s `HALTED`. Matched by prefix, so the tail can be reworded. */
export const HALTED_PREFIX = 'Atlas is halted';

export function isHaltedError(message: unknown): boolean {
  return typeof message === 'string' && message.startsWith(HALTED_PREFIX);
}

/** What the desktop shell reports about the stop, for Settings and the app shell. */
export interface HaltStatus {
  halted: boolean;
  /** Increments on every halt. Resetting names the one you saw, so a newer halt can't be cleared by accident. */
  epoch: number;
  shortcut: {
    /** The key Windows actually has registered, if any. */
    active: string | null;
    /** Why the requested key isn't the active one. */
    error: string | null;
  };
  defaultShortcut: string;
}

export type HaltSource = 'shortcut' | 'button';

export interface HaltEvent {
  epoch: number;
  source: HaltSource;
}

export type ShortcutCheck = { ok: true; value: string } | { ok: false; reason: string };

const STANDALONE = /^(F([1-9]|1\d|2[0-4])|PAUSE|SCROLLLOCK)$/;
const NEEDS_MODIFIER: Record<string, string> = {
  SPACE: 'Space',
  ESCAPE: 'Escape',
  INSERT: 'Insert',
  DELETE: 'Delete',
  HOME: 'Home',
  END: 'End',
  PAGEUP: 'PageUp',
  PAGEDOWN: 'PageDown',
};

function canonicalKey(upper: string): string {
  if (upper === 'PAUSE') return 'Pause';
  if (upper === 'SCROLLLOCK') return 'ScrollLock';
  return NEEDS_MODIFIER[upper] ?? upper;
}

/**
 * Validate and canonicalise a stop key — rule for rule the same as
 * `halt.rs`'s `parse_shortcut`, and tested against the same cases.
 *
 * The rules exist because a stop key is registered system-wide and swallows
 * the key everywhere: F-keys, Pause and Scroll Lock may stand alone; anything
 * you type or navigate with needs Ctrl, Alt or Win; a letter or digit needs
 * two modifiers (or Win), because Ctrl+C and friends belong to every app.
 */
export function parseHaltShortcut(text: string): ShortcutCheck {
  const parts = String(text ?? '')
    .split('+')
    .map((p) => p.trim());
  if (parts.some((p) => !p)) return { ok: false, reason: "That isn't a complete shortcut." };

  const key = parts.pop()!;
  const mods = { ctrl: false, alt: false, shift: false, win: false };
  for (const m of parts) {
    const lower = m.toLowerCase();
    const slot: keyof typeof mods | null =
      lower === 'ctrl' || lower === 'control'
        ? 'ctrl'
        : lower === 'alt'
          ? 'alt'
          : lower === 'shift'
            ? 'shift'
            : ['win', 'windows', 'meta', 'super'].includes(lower)
              ? 'win'
              : null;
    if (!slot) return { ok: false, reason: `“${m}” isn't a modifier key.` };
    if (mods[slot]) return { ok: false, reason: 'A modifier is listed twice.' };
    mods[slot] = true;
  }

  const upper = key.toUpperCase();
  const label = canonicalKey(upper);
  const single = /^[A-Z0-9]$/.test(upper);

  if (!STANDALONE.test(upper)) {
    if (!single && !(upper in NEEDS_MODIFIER)) {
      return { ok: false, reason: `“${key}” can't be used as a stop key.` };
    }
    if (!(mods.ctrl || mods.alt || mods.win)) {
      return { ok: false, reason: `${label} on its own is something you type. Add Ctrl, Alt or Win.` };
    }
    const count = Object.values(mods).filter(Boolean).length;
    if (single && count < 2 && !mods.win) {
      return {
        ok: false,
        reason: `Ctrl+${label} or Alt+${label} is already a shortcut in most apps. Use two modifiers, like Ctrl+Alt+${label}.`,
      };
    }
  }

  if (mods.ctrl && !mods.alt && !mods.shift && !mods.win && label === 'Space') {
    return { ok: false, reason: 'Ctrl+Space already summons Atlas.' };
  }
  if (mods.alt && !mods.ctrl && !mods.shift && !mods.win && label === 'F4') {
    return { ok: false, reason: "Alt+F4 closes windows — pick something that doesn't." };
  }
  if (mods.ctrl && mods.alt && label === 'Delete') {
    return { ok: false, reason: 'Ctrl+Alt+Delete belongs to Windows.' };
  }

  const value = [
    mods.ctrl && 'Ctrl',
    mods.alt && 'Alt',
    mods.shift && 'Shift',
    mods.win && 'Win',
    label,
  ]
    .filter(Boolean)
    .join('+');
  return { ok: true, value };
}

/**
 * Turn a key press in Settings' recorder into shortcut text, or null while
 * only modifiers are held. Uses `code` for letters and digits so the result
 * names the physical key regardless of layout or Shift.
 */
export function shortcutFromKeyEvent(e: {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key)) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (e.code === 'Space') key = 'Space';
  else if (e.key.length === 1) key = e.key.toUpperCase();
  else key = e.key === 'Esc' ? 'Escape' : e.key;
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win', key]
    .filter(Boolean)
    .join('+');
}

/**
 * The slice of `AbortSignal` the engine uses. Declared structurally because
 * this package has no DOM types by design; a real `AbortSignal` satisfies it.
 */
export interface HaltSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** Thrown (and caught) inside the engine only — never shown. */
export class HaltedError extends Error {
  constructor() {
    super(HALTED_PREFIX);
    this.name = 'HaltedError';
  }
}

/**
 * Wait for `work`, unless `signal` aborts first — then reject with
 * `HaltedError` immediately, without waiting for `work` to notice.
 *
 * This is what makes a halt land in bounded time regardless of what the thing
 * being waited on does: a skill that ignores the signal, a confirm card nobody
 * answers, a model that never replies. The abandoned promise is left to settle
 * on its own; nothing reads its result.
 */
export function untilHalted<T>(work: Promise<T>, signal: HaltSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(new HaltedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new HaltedError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * A minimal `AbortController` for the engine, which has no DOM types. One per
 * run; `Engine.halt()` aborts every live one.
 */
export class HaltController {
  private listeners = new Set<() => void>();
  private stopped = false;

  readonly signal: HaltSignal = {
    get aborted() {
      return false;
    },
    addEventListener: (_type, listener, options) => {
      if (this.stopped) return;
      const wrapped = options?.once
        ? () => {
            this.listeners.delete(wrapped);
            listener();
          }
        : listener;
      // Keep a handle to the original so removeEventListener finds it.
      (wrapped as { original?: () => void }).original = listener;
      this.listeners.add(wrapped);
    },
    removeEventListener: (_type, listener) => {
      for (const l of this.listeners) {
        if (l === listener || (l as { original?: () => void }).original === listener) {
          this.listeners.delete(l);
        }
      }
    },
  };

  constructor() {
    Object.defineProperty(this.signal, 'aborted', { get: () => this.stopped });
  }

  get aborted(): boolean {
    return this.stopped;
  }

  abort(): void {
    if (this.stopped) return;
    this.stopped = true;
    const pending = [...this.listeners];
    this.listeners.clear();
    for (const listener of pending) listener();
  }
}
