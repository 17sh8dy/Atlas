/**
 * Turning a reply written for the screen into text worth reading aloud.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Every skill message is written once and used twice: shown in the transcript
 * and, when speech is on, handed to a synthesiser. Those are different jobs.
 * `🏦 $84.50 after 3 years — $12.10 of that is interest.` is a fine thing to
 * *read* — the icon tags which skill answered, at a glance. It is a strange
 * thing to *hear*: a phonemiser has no idea what to do with a bank emoji, a
 * raw `D:\Dev\notes.txt` is read symbol by symbol rather than as a path, and
 * `·` — used everywhere in this codebase to separate short facts on one
 * line — carries no pause at all once spoken, so "41 GB free · 38% used"
 * comes out as one breathless run-on.
 *
 * Rather than rewrite every skill's message twice — once to read well, once to
 * sound right — this is the one seam both versions pass through: `useSpeech`
 * calls it on whatever text it was asked to say, immediately before handing
 * the result to `segmentForSpeech`. The transcript never sees this function's
 * output; it only ever touches what actually reaches a speaker.
 *
 * ── What is deliberately *not* here ──────────────────────────────────────────
 * Number-to-words, currency, percentages, times of day: `espeak-ng` — which
 * both engines phonemise through, directly or by way of Kokoro's own
 * `phonemize` in `kokoro.rs` — already expands "137", "3.5" and "38%" into
 * words as part of what it is for. Duplicating that here would be a second
 * implementation of a problem already solved correctly one layer down, with
 * two ways for the two to disagree instead of one place that can be wrong.
 * This function's job is everything *before* that: the symbols and shapes a
 * phonemiser was never going to understand in the first place, because they
 * are not language, they are formatting.
 *
 * Underscore emphasis (`_like this_`) is skipped for the same reason as a
 * different risk: underscores are ordinary characters in file names and
 * identifiers — `my_file_name.txt` — and a regex that cannot tell "paired
 * emphasis markers" from "two underscores that happen to both be there" will
 * occasionally eat a real one. Asterisks carry no such cost, so only they are
 * treated as emphasis.
 */

/**
 * Pictographic characters, their variation selector, skin-tone modifiers, and
 * the zero-width joiner that glues a multi-codepoint emoji together.
 *
 * `\p{Extended_Pictographic}` is the Unicode property built for exactly this —
 * broader than "emoji" in the strict sense, which is the point: it also
 * catches the dingbats and symbol pictographs Atlas's own skills use as icons
 * (🔋, 🗓️, ℹ️) without needing a hand-maintained list that goes stale the next
 * time a skill is added.
 */
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu;

/**
 * A keycap sequence \u2014 the hash, star, or digit symbols some skills use as
 * their icon, followed by the invisible characters that turn them into a
 * "keycap" glyph (an optional variation selector, then a combining enclosing
 * mark).
 *
 * Neither of those two invisible characters is `Extended_Pictographic`, and
 * the visible one (`#`, `*`, a plain digit) is not a pictograph on its own \u2014
 * so without this, a keycap icon loses its decoration and leaves the bare
 * character behind, heard as "hash" or "star" in the middle of a sentence
 * rather than nothing at all.
 */
const KEYCAP = /[0-9#*]\uFE0F?\u20E3/g;

/** ```lang\ncode\n``` — the fence removed, the content spoken as words. */
const CODE_FENCE = /```[^\n]*\n?([\s\S]*?)```/g;

/** `` `code` `` — the backticks removed, the content spoken as words. */
const INLINE_CODE = /`([^`\n]+)`/g;

/** `[label](url)` — spoken as the label; the destination is not a word. */
const MARKDOWN_LINK = /\[([^\]]+)\]\([^)]*\)/g;

/** A line opening with `#`, `>`, or a bullet marker — the marker only. */
const HEADING_MARKER = /^ {0,3}#{1,6}[ \t]+/gm;
const BLOCKQUOTE_MARKER = /^ {0,3}>[ \t]?/gm;
const BULLET_MARKER = /^[ \t]*[-*+][ \t]+/gm;

/**
 * `**bold**` and `*italic*`, in that order.
 *
 * Bold first: running the single-asterisk pattern on `**word**` would match
 * `*` + `*word*` + `*` from the inside out and leave a stray pair of asterisks
 * behind. Both require a non-space on each side of the run they wrap, which
 * is what keeps `3 * 4` — spaces on both sides of the mark — from being read
 * as emphasis around nothing.
 */
const BOLD_ASTERISK = /\*\*(\S(?:[^*]*\S)?)\*\*/g;
const ITALIC_ASTERISK = /\*(\S(?:[^*]*\S)?)\*/g;

/** `https://` or `http://`, with an optional `www.` — the scheme is not a word. */
const URL_SCHEME = /\bhttps?:\/\/(?:www\.)?/gi;

/**
 * A Windows path: a drive letter, a colon, a backslash, and whatever
 * non-space characters follow.
 *
 * `\S*` rather than a fuller grammar of what a path may contain: every path
 * Atlas's own skills produce is built from `String(args.path)` or a known
 * folder, and none of them contain a space in practice. A real path that does
 * — `C:\Program Files\App` — only converts up to the space; what follows is
 * left as ordinary words with an unconverted backslash still in it, which is
 * a real limitation and a survivable one: a stray backslash is silently
 * dropped by both engines rather than causing an error.
 */
const WINDOWS_PATH = /\b([A-Za-z]):\\(\S*)/g;

/**
 * Symbols with one unambiguous spoken word, replaced with padding on both
 * sides so a version used with no surrounding space ("1920×1080") and one
 * used with space on both sides ("2 × 2") both come out with exactly one —
 * the whitespace pass at the end of `prepareForSpeech` collapses the rest.
 *
 * `·` is Atlas's own convention (see `files.info`, `system.info`, and others)
 * for separating short independent facts on one line — closer to a semicolon
 * than to punctuation with no spoken form, which is why it becomes a full
 * stop rather than a word: "41 GB free. 38% used." gets the pause a listener
 * needs between two facts, where "41 GB free · 38% used" run together with
 * nothing spoken for the middle dot at all.
 */
const SYMBOL_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/×/g, ' times '],
  [/→/g, ' to '],
  // The space on each side of the mark is consumed along with it — replacing
  // only the character left a stray space before the new full stop ("free
  // . 38%"), which reads as its own small, meaningless pause.
  [/\s*·\s*/g, '. '],
];

/** Two-plus of a horizontal space, or spaces straddling a newline. */
const EXTRA_HORIZONTAL_SPACE = /[ \t]{2,}/g;
const LEADING_LINE_SPACE = /^[ \t]+/gm;
const TRAILING_LINE_SPACE = /[ \t]+$/gm;
const SPACE_AROUND_NEWLINE = /[ \t]*\n[ \t]*/g;

function naturalizeWindowsPaths(text: string): string {
  return text.replace(WINDOWS_PATH, (_match, drive: string, rest: string) => {
    const segments = rest.split(/[\\/]+/).filter(Boolean);
    return segments.length ? `${drive.toUpperCase()} drive, ${segments.join(', ')}` : `${drive.toUpperCase()} drive`;
  });
}

function stripMarkdown(text: string): string {
  let out = text;
  out = out.replace(CODE_FENCE, '$1');
  out = out.replace(INLINE_CODE, '$1');
  out = out.replace(MARKDOWN_LINK, '$1');
  out = out.replace(HEADING_MARKER, '');
  out = out.replace(BLOCKQUOTE_MARKER, '');
  out = out.replace(BULLET_MARKER, '');
  out = out.replace(BOLD_ASTERISK, '$1');
  out = out.replace(ITALIC_ASTERISK, '$1');
  return out;
}

/**
 * Everything above, in the order that keeps each step's input the shape it
 * expects: markdown comes off before a `*` inside a URL or path could ever be
 * mistaken for emphasis, paths and URLs are naturalised before the symbol
 * table would otherwise leave a stray `×` or `·` alone in what is left of
 * them, and whitespace is collapsed last, once nothing further will introduce
 * more of it.
 *
 * Newlines are preserved rather than joined into spaces: `segmentForSpeech`
 * reads a blank line as a longer pause than a full stop, which is exactly
 * what a paragraph break should sound like, and joining them here would
 * remove information that function still needs.
 */
export function prepareForSpeech(text: string): string {
  let out = String(text ?? '');
  if (!out.trim()) return '';

  out = out.replace(KEYCAP, '');
  out = out.replace(EMOJI, '');
  out = stripMarkdown(out);
  out = out.replace(URL_SCHEME, '');
  out = naturalizeWindowsPaths(out);
  for (const [pattern, replacement] of SYMBOL_WORDS) out = out.replace(pattern, replacement);

  out = out.replace(SPACE_AROUND_NEWLINE, '\n');
  out = out.replace(LEADING_LINE_SPACE, '');
  out = out.replace(TRAILING_LINE_SPACE, '');
  out = out.replace(EXTRA_HORIZONTAL_SPACE, ' ');

  return out.trim();
}
