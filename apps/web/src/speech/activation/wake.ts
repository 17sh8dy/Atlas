/**
 * Recognising a typed wake phrase in what the local transcriber heard.
 *
 * ── Why this and not a trained wake-word model ──────────────────────────────────────────────────────
 * A wake-word engine needs one trained model per word, which means the person could only choose from a
 * short list or record samples. Instead the person TYPES the phrase, and Atlas listens for it in the
 * transcript of short bursts of speech, which the on-device speech engine already produces. Any words work,
 * immediately, and nothing is trained or downloaded.
 *
 * The cost is honest and shown in Settings: while this is on, each burst of speech is transcribed on this PC
 * (the transcript is looked at for the phrase and thrown away, never stored or logged), so it uses some
 * processor time when there is talking in the room, and it reacts about a second after the phrase is said.
 *
 * ── Matching ─────────────────────────────────────────────────────────────────────────────────────────
 * Transcribers mishear names ("Atlas" → "at last", "atlus"), so an exact match would miss half the time and
 * a loose one would fire on the TV. The phrase must appear within the first few words of the burst, with its
 * letters allowed to differ by about one in five once spaces and punctuation are ignored. Whatever follows is
 * returned, so "Hey Atlas, open Spotify" is one gesture and not two.
 */

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu))
    out.push({ text: m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length });
  return out;
}

/** Edit distance, capped: bail out as soon as it exceeds `limit`. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** How many leading words may come before the phrase ("okay, hey atlas"). */
const MAX_LEAD_WORDS = 2;

export interface WakeMatch {
  matched: boolean;
  /** What was said after the phrase, as heard, or '' when nothing followed. */
  rest: string;
}

/** Greeting words a phrase may open with. They are the part transcribers mishear most ("hey" → "pay", "hay", "hei"). */
const GREETINGS = new Set(['hey', 'hay', 'hi', 'hello', 'ok', 'okay', 'yo']);

export function matchWake(heard: string, phrase: string): WakeMatch {
  const direct = matchPhrase(heard, phrase);
  if (direct.matched) return direct;
  // A phrase that opens with a greeting ("Hey Atlas"): the NAME is what identifies it, and the greeting may have
  // been misheard as some other short word ("Pay Atlas"). Accept the name when the word right before it sounds
  // enough like the greeting (within two letters), never the name alone.
  const want = tokens(phrase).map((t) => t.text);
  const greeting = want[0];
  if (!greeting || !GREETINGS.has(greeting) || want.length < 2) return direct;
  const name = want.slice(1).join(' ');
  const have = tokens(heard);
  for (let at = 1; at <= Math.min(MAX_LEAD_WORDS, have.length - 1); at++) {
    const before = have[at - 1]!.text;
    // Three letters or more (so "my atlas" is not "hey atlas"), within two letters of the greeting.
    if (before.length < Math.min(3, greeting.length) || editDistance(before, greeting, 2) > 2)
      continue;
    const tail = matchPhrase(heard.slice(have[at]!.start), name);
    if (tail.matched) return tail;
  }
  return direct;
}

function matchPhrase(heard: string, phrase: string): WakeMatch {
  const none: WakeMatch = { matched: false, rest: '' };
  const want = tokens(phrase).map((t) => t.text);
  if (!want.length) return none;
  const target = want.join('');
  const limit = Math.max(1, Math.floor(target.length * 0.2));
  const have = tokens(heard);

  let best: { end: number; distance: number } | null = null;
  for (let start = 0; start <= Math.min(MAX_LEAD_WORDS, have.length - 1); start++) {
    // The phrase may have been heard as one word more or fewer ("atlas" / "at last").
    for (
      let k = Math.max(1, want.length - 1);
      k <= Math.min(want.length + 1, have.length - start);
      k++
    ) {
      const candidate = have
        .slice(start, start + k)
        .map((t) => t.text)
        .join('');
      const distance = editDistance(candidate, target, limit);
      if (
        distance <= limit &&
        (!best || distance < best.distance || (distance === best.distance && start + k < best.end))
      ) {
        best = { end: start + k, distance };
      }
    }
  }
  if (!best) return none;
  const last = have[best.end - 1]!;
  const rest = heard
    .slice(last.end)
    .replace(/^[\s,.:;!?'"”’-]+/, '')
    .trim();
  return { matched: true, rest };
}
