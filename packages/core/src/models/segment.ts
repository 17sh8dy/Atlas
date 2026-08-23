/**
 * Cutting a reply into the pieces it will be spoken in.
 *
 * ── Why a reply is not synthesised in one go ────────────────────────────────
 * Synthesis is faster than speech — comfortably — but it is not instant, and
 * the wait is proportional to the *whole* reply. Synthesising four sentences
 * as one utterance means the room stays silent until the fourth one is ready,
 * even though the first was ready almost immediately. Cut the reply up and the
 * first sentence can start while the rest is still being made, so the wait
 * stops being "how long is the answer" and becomes "how long is its first
 * sentence".
 *
 * That is the single biggest thing available to make a voice feel responsive,
 * and it is worth more than any amount of model quality: a better voice that
 * starts late still feels slow.
 *
 * ── The first piece is deliberately the smallest ────────────────────────────
 * Everything after the first is synthesised while something is already
 * playing, so its only job is to stay ahead of the speaker — and at any
 * sensible real-time factor it will. The first piece is the only one anybody
 * actually waits for. So the rules are asymmetric on purpose: the first
 * sentence is allowed to stand alone however short it is, and later pieces are
 * merged up to a floor, because each piece costs a round trip and there is no
 * reason to pay for twenty of them once the sound is already going.
 *
 * ── Why not just split on "." ───────────────────────────────────────────────
 * Because "3.5 GB free" becomes "3" / "5 GB free", and an assistant that reads
 * disk space as two sentences is worse than one that pauses oddly. The guards
 * below are the ones that actually come up in what Atlas says: decimals,
 * version numbers, abbreviations, and initials.
 */

/**
 * Longest piece worth making, in characters.
 *
 * Two independent ceilings meet here. Kokoro's context is 510 phonemes, which
 * is roughly 400 characters of English and is a hard failure when exceeded;
 * and a piece longer than a few seconds stops buying anything, since the point
 * is to get sound started, not to batch efficiently. 320 sits under both.
 */
const MAX_CHARS = 320;

/**
 * Shortest piece worth making on its own, after the first.
 *
 * Below this the per-piece overhead — a round trip and a synthesis call —
 * costs more than the pipelining saves, and the seams between very short
 * pieces are where uneven pacing becomes audible.
 */
const MIN_CHARS = 120;

/**
 * Words that end in a full stop without ending a sentence.
 *
 * Deliberately short. This is a list of what *Atlas* says, not of English:
 * every entry here earns its place by appearing in a real reply — units,
 * titles, and the two Latin abbreviations that turn up in explanations.
 */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'st',
  'vs',
  'etc',
  'inc',
  'ltd',
  'co',
  'no',
  'fig',
  'approx',
  'est',
  'dept',
  'min',
  'max',
  'sec',
  'hr',
  'e.g',
  'i.e',
  'a.m',
  'p.m',
]);

/**
 * Split `text` into pieces to be synthesised in order.
 *
 * Returns an empty array for empty input. Every piece is trimmed and
 * non-empty, and concatenating them recovers the original words — nothing is
 * dropped, because a sentence that goes missing from the audio but not from
 * the screen is the hardest kind of bug to notice.
 */
export function segmentForSpeech(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = splitSentences(trimmed);

  const pieces: string[] = [];
  for (const sentence of sentences) {
    // A sentence longer than the ceiling is broken at the best seam it has:
    // a clause boundary if there is one, a word boundary otherwise. Never
    // mid-word, which is the one split a listener would actually notice.
    for (const part of breakLong(sentence)) {
      const last = pieces[pieces.length - 1];
      // Merge into the tail only when the tail is not the first piece. The
      // first ships the moment it is whole — that is the entire latency win —
      // and every piece after it is filled up to the floor before it is sent.
      const mergeable =
        last !== undefined &&
        pieces.length > 1 &&
        last.length < MIN_CHARS &&
        last.length + part.length + 1 <= MAX_CHARS;

      if (mergeable) pieces[pieces.length - 1] = `${last} ${part}`;
      else pieces.push(part);
    }
  }

  return pieces;
}

/**
 * Sentence boundaries, with the guards that stop numbers and abbreviations
 * from being mistaken for them.
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    // A newline is a boundary in its own right. Replies are written in
    // paragraphs and a blank line is a longer pause than a full stop, which
    // is exactly what starting a new piece produces.
    if (char === '\n') {
      const piece = text.slice(start, i).trim();
      if (piece) out.push(piece);
      start = i + 1;
      continue;
    }

    if (char !== '.' && char !== '!' && char !== '?' && char !== '…') continue;

    // Run past a cluster of terminators so "Really?!" and "Wait..." are one
    // boundary rather than two or three, and the marks stay with the sentence.
    let end = i;
    while (end + 1 < text.length && '.!?…'.includes(text[end + 1]!)) end++;

    if (!isBoundary(text, i, end)) {
      i = end;
      continue;
    }

    const piece = text.slice(start, end + 1).trim();
    if (piece) out.push(piece);
    start = end + 1;
    i = end;
  }

  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Is the terminator at `first`..`last` really the end of a sentence?
 */
function isBoundary(text: string, first: number, last: number): boolean {
  const next = text[last + 1];

  // Nothing follows: certainly the end.
  if (next === undefined) return true;

  // A terminator must be followed by space or a closing quote/bracket to end a
  // sentence. "example.com" and "3.5" both fail here, which is the point.
  if (!/[\s"'”’)\]]/.test(next)) return false;

  // Only a full stop is ambiguous. "!" and "?" mid-word are not a thing Atlas
  // produces, and "…" is always a real pause.
  if (text[first] !== '.' || last !== first) return true;

  // Look back at the word the stop is attached to.
  let wordStart = first;
  while (wordStart > 0 && /[^\s]/.test(text[wordStart - 1]!)) wordStart--;
  const word = text.slice(wordStart, first).toLowerCase();

  // A single letter before a stop is an initial — "J. R. R. Tolkien" — and
  // splitting there produces three sentences of one letter each.
  if (/^[a-z]$/.test(word)) return false;

  if (ABBREVIATIONS.has(word)) return false;

  // A stop between digits is a decimal or a version, and `next` being
  // whitespace already ruled out "3.5". What is left is "Windows 11." at the
  // end of a sentence, which is a real boundary.
  return true;
}

/**
 * Break a single over-long sentence into pieces no larger than the ceiling.
 *
 * Prefers clause boundaries — a listener hears a pause at a comma as
 * punctuation, and a pause mid-clause as a stutter.
 */
function breakLong(sentence: string): string[] {
  if (sentence.length <= MAX_CHARS) return [sentence];

  const out: string[] = [];
  let rest = sentence;

  while (rest.length > MAX_CHARS) {
    const window = rest.slice(0, MAX_CHARS);

    // The last clause break in range, then the last space. Searching for the
    // *last* rather than the first keeps pieces as full as they can be, which
    // keeps their number down.
    let cut = Math.max(
      window.lastIndexOf('; '),
      window.lastIndexOf(', '),
      window.lastIndexOf(' — '),
      window.lastIndexOf(': '),
    );
    // Only take a clause break if it is past the halfway mark; a comma at
    // character 12 of a 320-character window makes a piece far too small.
    if (cut < MAX_CHARS / 2) cut = window.lastIndexOf(' ');
    // A single unbroken token longer than the ceiling. Nothing to do but cut
    // it. `cut` is an index and the slice below is inclusive of it, so the
    // last character kept is at MAX_CHARS - 1.
    if (cut <= 0) cut = MAX_CHARS - 1;

    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }

  if (rest) out.push(rest);
  return out;
}
