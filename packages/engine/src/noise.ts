/**
 * Is this message something nobody could act on? A lone letter ("g"), keyboard mash ("asdfgh",
 * "hjkl", "xcvbn"), a run of one character ("aaaa"), only punctuation ("???"), or several of those
 * together ("g h j"). Atlas answers these by saying what it heard and asking what was meant — not by
 * explaining a missing language model, which was never the problem.
 *
 * Deliberately conservative the other way: real words, two-letter words ("ok", "no", "up"), answers
 * ("y", "n", "k"), numbers, smileys and emoji are NOT noise. A wrong "what did you mean?" to a real
 * message is worse than a missed one, so every rule here only fires on something no language has.
 */

/** Real two-letter words, plus the one-letter answers people type on their own. */
const SHORT_OK = new Set([
  'ok', 'hi', 'no', 'so', 'go', 'up', 'me', 'we', 'be', 'do', 'is', 'it', 'on', 'to', 'of', 'my', 'an', 'as', 'at', 'by', 'he', 'if', 'in', 'or',
  'oh', 'ah', 'uh', 'um', 'er', 'yo', 'us', 'am', 'ax', 'ex', 'ha', 'hm', 'mm', 'ya', 'ye',
  'y', 'n', 'k',
]);

/** Sounds people make while thinking. Not gibberish, and not a request either. */
const FILLERS = new Set(['uh', 'um', 'er', 'erm', 'hm', 'hmm', 'hmmm', 'mm', 'mmm', 'mhm', 'ah', 'oh', 'huh', 'eh']);

/** Real words with no vowel at all (y counts as one). */
const NO_VOWEL_WORDS = new Set(['hmm', 'hmmm', 'mm', 'mmm', 'mhm', 'shh', 'sh', 'brr', 'pfft', 'psst', 'tsk', 'nth', 'cwm', 'grr', 'zzz', 'xkcd', 'tv', 'pc', 'cd', 'dj', 'mr', 'dr', 'vs']);

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];
const ROWS_BOTH_WAYS = [...KEYBOARD_ROWS, ...KEYBOARD_ROWS.map((r) => [...r].reverse().join(''))];

/** Four or more neighbouring keys in a row: "asdf", "hjkl", "xcvb", "poiu". */
function keyboardRun(word: string): boolean {
  if (word.length < 4) return false;
  return ROWS_BOTH_WAYS.some((row) => row.includes(word));
}

function consonantRun(word: string): number {
  let longest = 0;
  let run = 0;
  for (const c of word) {
    if (/[aeiouy]/.test(c)) run = 0;
    else longest = Math.max(longest, ++run);
  }
  return longest;
}

/** One whitespace-free piece of a message: is it noise? */
function wordIsNoise(raw: string): boolean {
  const word = raw.toLowerCase();
  if (SHORT_OK.has(word) || NO_VOWEL_WORDS.has(word)) return false;
  if (/^\d+$/.test(word)) return word.length === 1; // "5" alone is a fragment; "42" is a number
  if (!/^\p{L}+$/u.test(word)) return false; // mixed letters/digits ("mp3", "4k", "x7") might be anything
  if ([...word].length === 1) return true; // a lone letter
  if ([...word].length === 2) return !/[aeiouy]/.test(word); // "gh", "xz" — but "ab" at least has a vowel
  if (/^(.)\1{2,}$/.test(word)) return true; // "aaaa", "gggg" ("hmm" and "zzz" were allowed above)
  if (keyboardRun(word)) return true;
  if (!/[aeiouy]/.test(word)) return true;
  // A run of six consonants does not occur in English ("strengths" has five).
  return consonantRun(word) >= 6;
}

/** `emoticon` and emoji are intentional, so they are never noise. */
const EMOTICON = /^[:;=8xX][-^o']?[)(DPpOo/\\|3]$|^<3$|^\^_\^$|^[oO][_.][oO]$/;
const EMOJI = /\p{Extended_Pictographic}/u;

export type Noise = { kind: 'noise' | 'filler'; shown: string };

/**
 * Classify a whole message. `null` means it is a real message and should be handled as usual.
 * Capped at six pieces: a longer string of nothing in particular is somebody pasting, not typing.
 */
export function classifyNoise(text: string): Noise | null {
  const shown = text.trim();
  if (!shown || shown.length > 40) return null;
  if (EMOJI.test(shown) || EMOTICON.test(shown)) return null;
  // Only punctuation and symbols: "???", "...", "@#$".
  if (!/[\p{L}\p{N}]/u.test(shown)) return { kind: 'noise', shown };
  const pieces = shown.split(/[\s,;.]+/).filter(Boolean).map((p) => p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  const words = pieces.filter(Boolean);
  if (!words.length || words.length > 6) return null;
  if (words.every((w) => FILLERS.has(w.toLowerCase()))) return { kind: 'filler', shown };
  return words.every(wordIsNoise) ? { kind: 'noise', shown } : null;
}

/** What Atlas says. Quotes what it received, so the person can see what arrived. */
export function noiseReply(noise: Noise): string {
  if (noise.kind === 'filler') return 'I’m here. What do you need?';
  return `You just said “${noise.shown}” — what did you mean to type, or what do you need?`;
}
