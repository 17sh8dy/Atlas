/**
 * How tall the message box may get, and when it should scroll instead.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * The box grows with what is typed or pasted, so a long message is never
 * squeezed into a one-line slot. It stops growing at a share of the window —
 * never a fixed number, because 160px is a lot on a small window and almost
 * nothing on a large one — and from there it scrolls inside itself. It never
 * grows without limit, and it never takes the conversation off the screen.
 *
 * Kept as plain functions so the behaviour that matters (a huge paste stays
 * within bounds and scrolls; a short message never shows a scrollbar) is
 * tested directly, not inferred from a browser.
 */

/** The box's own smallest height: one line of text plus its padding. */
export const MIN_HEIGHT = 32;

/** Never smaller than this, however short the window is: about four lines. */
const FLOOR = 112;
/** Never larger than this, however tall the window is: about fifteen lines. */
const CEILING = 360;
/** The share of the window the box may take. */
const SHARE = 0.4;

export function composerMaxHeight(viewportHeight: number): number {
  const v = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
  return Math.min(CEILING, Math.max(FLOOR, Math.round(v * SHARE)));
}

export interface Fit {
  /** Pixels to set the box to. */
  height: number;
  /** True once the content is taller than the box: it must scroll. */
  scrolls: boolean;
}

/**
 * `contentHeight` is the textarea's `scrollHeight` measured with its height
 * reset, i.e. how tall the text really is.
 */
export function fitComposer(contentHeight: number, viewportHeight: number): Fit {
  const max = composerMaxHeight(viewportHeight);
  const content = Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 0;
  const height = Math.max(MIN_HEIGHT, Math.min(content, max));
  return { height, scrolls: content > max };
}

/** Where a long message gets a note, and where it gets a warning. */
export const NOTE_FROM = 4_000;
/** The most Atlas can send to a model in one message (matches the native limit). */
export const SEND_LIMIT = 100_000;

export type LengthNote = { tone: 'info' | 'warn'; text: string };

/**
 * A quiet character count for a long message, and a plain warning past what
 * can be sent to a model. Nothing for an ordinary message: a counter on every
 * message would be noise.
 */
export function lengthNote(chars: number): LengthNote | null {
  if (chars > SEND_LIMIT) {
    return {
      tone: 'warn',
      text: `${chars.toLocaleString('en-US')} characters — too long to send to a model in one message (the limit is ${SEND_LIMIT.toLocaleString('en-US')}). Split it up.`,
    };
  }
  if (chars >= NOTE_FROM)
    return { tone: 'info', text: `${chars.toLocaleString('en-US')} characters` };
  return null;
}
