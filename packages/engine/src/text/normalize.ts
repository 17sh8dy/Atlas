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

/**
 * A named mechanism wrapping an instruction — "use keyboard and mouse
 * control to open Chrome", "using the mouse to click submit".
 *
 * `appOpen` and the other tier-1 rules are anchored on the verb; naming *how*
 * to do something puts a mechanism clause ahead of that verb the same way a
 * greeting does, so the message misses every rule, falls through triage, and
 * — same failure as an unmatched typo — lands on "I couldn't reach that
 * provider" once the AI tier is asked and it happens to be offline. But the
 * mechanism is never the point: "open Chrome" already means launch it by
 * whatever means gets there fastest, and Atlas has no separate "open an app
 * by clicking its icon" skill for this to preserve — there is nothing more
 * literal to fall back to. Stripped here so the instruction reaches the same
 * deterministic rule a plain "open Chrome" would have, tier 1, no model
 * needed. An instruction that genuinely needs synthetic input names its
 * target directly — "click at 500, 300", "type 'hello'" — and those rules
 * match on their own without this wrapper ever being in the way.
 */
const MECHANISM_PREFIX =
  /^\s*(?:use|using|via|with)\s+(?:the\s+)?(?:keyboard|mouse)(?:\s*(?:and|\/|,)\s*(?:the\s+)?(?:keyboard|mouse))?(?:\s+control)?\s+to\s+/i;

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
  out = out.replace(MECHANISM_PREFIX, '');
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
  /\s+(?:on|in|with|using|through|via)\s+(?:my\s+|the\s+|a\s+)?(google|chrome|edge|firefox|safari|opera|brave|vivaldi|arc|zen|chromium|web\s*browser|browser|internet|web|online)\s*$/i;

/**
 * The words in `BROWSER_HINT` that name an actual, distinct browser rather
 * than a generic stand-in for "the internet" ("google", "the web", "my
 * browser"). Only these are worth resolving against `listApps()` — the rest
 * have never named a specific application and asking `app.open`'s resolver
 * to find an app called "browser" would either fail oddly or match the wrong
 * thing outright. Kept in sync with `BROWSER_NAMES` in `core-skills.ts` by
 * hand — small, rarely-changed lists, and importing across that boundary
 * would pull a skills file into text normalisation for six literals.
 */
const NAMED_BROWSERS = new Set([
  'chrome',
  'edge',
  'firefox',
  'safari',
  'opera',
  'brave',
  'vivaldi',
  'arc',
  'zen',
  'chromium',
]);

export interface BrowserHint {
  /** The request with the hint removed. */
  text: string;
  /** True when the user explicitly asked for a browser, named or not. */
  wantsBrowser: boolean;
  /** Which one, when it was an actual browser name and not "google"/"the web". */
  browser?: string;
}

export function splitBrowserHint(text: string): BrowserHint {
  const raw = String(text ?? '');
  const m = raw.match(BROWSER_HINT);
  if (!m) return { text: raw.trim(), wantsBrowser: false };
  const word = m[1]!.toLowerCase().replace(/\s+/g, '');
  return {
    text: raw.slice(0, m.index ?? 0).trim(),
    wantsBrowser: true,
    browser: NAMED_BROWSERS.has(word) ? word : undefined,
  };
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
