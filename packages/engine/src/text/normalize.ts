/**
 * Turning how people actually talk into something the grammar can match.
 *
 * The grammar's rules are anchored — `appOpen` wants a message that *starts*
 * with "open". That is deliberate and worth keeping, because an unanchored
 * rule matches "remind me not to open Steam". But it means "yo and open
 * YouTube" misses every rule, falls through triage into the AI planner, finds
 * no provider, and gets answered with a paragraph about external models. The
 * request was perfectly clear; only the greeting was in the way.
 *
 * So: strip the conversational wrapper, then let the same anchored rules run
 * again. No rule changes, no new matching, and the failure mode disappears.
 *
 * ── The rule about what may be removed ──────────────────────────────────────
 * Only words that carry no instruction. "please", "can you", "for me" can go;
 * "not", "instead", "again", "all", "my" cannot, and neither can anything that
 * might be part of a name. When in doubt, leave it — a message that stays
 * unmatched falls through to conversation, while a message stripped of a
 * meaningful word becomes a confidently wrong action.
 *
 * `Engine.ask` only uses this on the second attempt, after the raw text has
 * already failed to match, so normalisation can never change how an already
 * understood sentence is handled.
 */

/** Greetings and filler that can open a message without changing it. */
const LEADING_FILLER =
  /^\s*(?:(?:yo|hey|hi|hello|ok|okay|so|um|uh|well|alright|right|sup|dude|man|bro|pls|plz|please|thanks|thank you|atlas)\b[\s,.!—-]*)+/i;

/**
 * Polite framings that wrap an instruction. Each ends by handing over to the
 * real verb, so removing the wrapper leaves the instruction intact.
 */
const POLITE_PREFIX =
  /^\s*(?:(?:i\s+(?:want|need|would like|wanna)\s+(?:you\s+)?to|can|could|would|will|can you please|could you please)\s+(?:you\s+|u\s+)?(?:please\s+)?|(?:please|pls|plz)\s+)/i;

/** Trailing courtesies. */
const TRAILING_FILLER =
  /[\s,]*(?:\b(?:please|pls|plz|for me|thanks|thank you|thx|ty|mate|man|dude|bro)\b[\s,.!]*)+$/i;

/** A conjunction left stranded at the front once a greeting is removed. */
const STRANDED_CONJUNCTION = /^\s*(?:and|then|also|but)\s+/i;

/**
 * Strip conversational filler from a request.
 *
 * Returns the message unchanged when there was nothing to remove, and never
 * returns an empty string — a message made only of filler ("hey", "thanks")
 * is left alone, because there is no instruction hiding in it and the
 * conversation layer should answer it as what it is.
 */
export function stripFiller(text: string): string {
  const original = String(text ?? '');
  let out = original;

  // Order matters: the greeting comes off first, which is what exposes a
  // polite prefix ("yo can you open…") to the pattern that handles it.
  out = out.replace(LEADING_FILLER, '');
  out = out.replace(STRANDED_CONJUNCTION, '');
  out = out.replace(POLITE_PREFIX, '');
  out = out.replace(TRAILING_FILLER, '');
  out = out.replace(/\s+/g, ' ').trim();

  if (!out) return original.trim();
  return out;
}

/**
 * Browser hints — "on Google", "in Chrome", "in my browser".
 *
 * These say *where* to open something rather than *what* to open, and left in
 * place they become part of the name: "open YouTube on Google" asks for an app
 * called "youtube on google". Pulled off here so the name is clean and the
 * caller knows the browser was requested explicitly.
 *
 * "Google" is in the list because that is how people say "the internet". It is
 * only ever read as a destination hint in the trailing position, so "open
 * Google" still means Google itself.
 */
const BROWSER_HINT =
  /\s+(?:on|in|with|using|through|via)\s+(?:my\s+|the\s+|a\s+)?(?:google|chrome|edge|firefox|safari|opera|brave|browser|web\s*browser|internet|web|online)\s*$/i;

export interface BrowserHint {
  /** The request with the hint removed. */
  text: string;
  /** True when the user explicitly asked for a browser. */
  wantsBrowser: boolean;
}

export function splitBrowserHint(text: string): BrowserHint {
  const raw = String(text ?? '');
  const stripped = raw.replace(BROWSER_HINT, '');
  return stripped === raw
    ? { text: raw.trim(), wantsBrowser: false }
    : { text: stripped.trim(), wantsBrowser: true };
}

/**
 * The full pass: filler off, browser hint off.
 *
 * Used by `Engine.ask` for its second parse attempt and by the grammar rule
 * that handles an explicit "open X in the browser".
 */
export function normalizeRequest(text: string): string {
  return stripFiller(text);
}
