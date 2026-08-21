/**
 * Reading "yes" and "no" out of an ordinary sentence.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A confirmation card has two buttons, which is a complete answer to the
 * question "how do I confirm this" right up until the moment you are talking
 * rather than typing. Then it is a dead end: Atlas asks, and the only way to
 * answer is to stop what you are doing, find the mouse, and click — which is
 * the exact thing an assistant you can talk to is supposed to remove.
 *
 * So a confirmation can also be answered by saying so. That needs one
 * deterministic function, not a model: the set of ways people say yes is small,
 * closed, and does not change.
 *
 * ── Only a whole answer counts ──────────────────────────────────────────────
 * This matches the *entire* utterance, never a word inside one. "no" is an
 * answer; "no, open Firefox instead" is not — it is a new instruction that
 * happens to start with a refusal, and treating it as a bare "no" would throw
 * away everything after the comma. The caller decides what to do with `null`,
 * which is the honest answer for anything this cannot read as a plain yes or
 * no.
 */

import { stripFiller } from './normalize';

/**
 * Whole-utterance affirmations.
 *
 * Written out rather than pattern-matched on a prefix, because prefixes are
 * how "yes" ends up matching "yesterday" and "no" ends up matching "notes".
 */
const YES = new Set([
  'y',
  'yes',
  'yes please',
  'yes do it',
  'yeah',
  'yea',
  'yep',
  'yup',
  'yup do it',
  'sure',
  'sure thing',
  'ok',
  'okay',
  'okay do it',
  'k',
  'do it',
  'do that',
  'go on',
  'go ahead',
  'go for it',
  'please do',
  'please',
  'confirm',
  'confirmed',
  'affirmative',
  'absolutely',
  'definitely',
  'certainly',
  'of course',
  'correct',
  'right',
  'aye',
  'alright',
  'all right',
  'fine',
  'accept',
  'approve',
  'agreed',
  'carry on',
  'proceed',
  'continue',
]);

const NO = new Set([
  'n',
  'no',
  'no thanks',
  'no thank you',
  'nope',
  'nah',
  'naw',
  'negative',
  'cancel',
  'cancel it',
  'cancel that',
  'stop',
  'stop it',
  'dont',
  "don't",
  'do not',
  'dont do it',
  "don't do it",
  'never mind',
  'nevermind',
  'forget it',
  'forget that',
  'leave it',
  'abort',
  'decline',
  'reject',
  'skip',
  'skip it',
  'not now',
  'no dont',
  "no don't",
  'wait',
  'hold on',
]);

export type Affirmation = 'yes' | 'no';

/**
 * `'yes'`, `'no'`, or `null` when the text is neither.
 *
 * Punctuation and filler come off first, so "yes, please!" and "erm, yeah"
 * both read as agreement — those are the same answer said by a person rather
 * than by a form.
 */
export function readAffirmation(text: string): Affirmation | null {
  const cleaned = normalise(text);
  if (!cleaned) return null;
  if (YES.has(cleaned)) return 'yes';
  if (NO.has(cleaned)) return 'no';

  // Filler is stripped only as a second attempt, for the same reason
  // `Engine.ask` retries the grammar that way: an utterance that already reads
  // as an answer must never be reinterpreted into a different one.
  const stripped = normalise(stripFiller(cleaned));
  if (stripped && stripped !== cleaned) {
    if (YES.has(stripped)) return 'yes';
    if (NO.has(stripped)) return 'no';
  }

  return null;
}

function normalise(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    // Apostrophes are kept — "don't" is in the table — but everything else
    // that a transcriber sprinkles on the end of a sentence comes off.
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
