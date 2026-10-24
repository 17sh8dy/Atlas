/**
 * The token estimator: one heuristic for everything in Atlas that has to guess how many tokens a
 * piece of text costs. Its Rust twin is `apps/desktop/src-tauri/src/tokens.rs`; both read
 * `token-weights.json` and must agree to the token on every fixture in `test/token-fixtures.json`.
 *
 * It is an ESTIMATE, always shown as one. The number a provider or model server reports is used
 * whenever there is one; this only fills the gap, and `calibration` (learned from those reports)
 * nudges it toward the model actually in use.
 *
 * Integer maths on purpose (milli-tokens): floating point would let the two languages drift.
 */
import weights from './token-weights.json';

export type ContentKind = 'prose' | 'code' | 'json' | 'logs';

type PerChar = typeof weights.perChar;

/** Which weight a character gets. Ranges are disjoint; order only matters for readability. */
function charClass(cp: number): keyof PerChar {
  if (cp === 0x20 || cp === 0x09) return 'space';
  if (cp === 0x0a || cp === 0x0d) return 'newline';
  if (cp >= 0x30 && cp <= 0x39) return 'digit';
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 'alnum';
  if (cp < 0x80) return 'punct';
  if (cp === 0x200d || cp === 0xfe0f || cp === 0xfe0e || (cp >= 0x1f3fb && cp <= 0x1f3ff)) return 'joiner';
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x20d0 && cp <= 0x20ff)) return 'combining';
  if ((cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2190 && cp <= 0x2bff)) return 'emoji';
  if (
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  ) {
    return 'cjk';
  }
  if ((cp >= 0x0590 && cp <= 0x06ff) || (cp >= 0x0900 && cp <= 0x0dff) || (cp >= 0x0e00 && cp <= 0x0eff)) {
    return 'otherScript';
  }
  if ((cp >= 0x00a0 && cp <= 0x024f) || (cp >= 0x0370 && cp <= 0x052f)) return 'latinExt';
  return 'other';
}

/** Trim only ASCII whitespace, so the Rust twin (which cannot use JS's trim) agrees. */
function trimAscii(s: string): string {
  let a = 0;
  let b = s.length;
  const ws = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  while (a < b && ws(s.charAt(a))) a++;
  while (b > a && ws(s.charAt(b - 1))) b--;
  return s.slice(a, b);
}

const SYMBOLS = '{}[]()<>;=+*/\|&^~';

/** A cheap single-pass guess at what kind of text a paragraph is. */
export function classify(paragraph: string): ContentKind {
  const t = trimAscii(paragraph);
  let n = 0;
  let sym = 0;
  let quotes = 0;
  for (const ch of t) {
    n++;
    if (ch === '"') quotes++;
    if (SYMBOLS.includes(ch)) sym++;
  }
  if (n === 0) return 'prose';

  const first = t.charAt(0);
  const last = t.charAt(t.length - 1);
  if ((first === '{' || first === '[') && (last === '}' || last === ']') && quotes * 10 >= n) return 'json';

  let lines = 0;
  let indented = 0;
  let logish = 0;
  for (const line of t.split('\n')) {
    if (trimAscii(line).length === 0) continue;
    lines++;
    if (line.startsWith('  ') || line.startsWith('\t')) indented++;
    const c = line.charAt(0);
    if (((c >= '0' && c <= '9') || c === '[') && line.includes(':')) logish++;
  }
  if (lines >= 3 && logish * 10 >= lines * 6) return 'logs';
  if (t.includes('```') || sym * 100 >= n * 6 || (lines >= 3 && indented * 10 >= lines * 4)) return 'code';
  return 'prose';
}

function rawMilli(text: string): number {
  let sum = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    sum += weights.perChar[charClass(cp)];
  }
  return sum;
}

function totalMilli(text: string, forced?: ContentKind): number {
  const parts = text.split('\n\n');
  let total = 0;
  parts.forEach((part, i) => {
    const kind = forced ?? classify(part);
    total += Math.floor((rawMilli(part) * weights.kind[kind]) / 1000);
    // The blank line between two paragraphs is two newlines.
    if (i > 0) total += 2 * weights.perChar.newline;
  });
  return total;
}

/**
 * Estimated tokens in `text`, rounded up. `calibrationPermille` scales the result by what real
 * counts have taught us about this model (1000 = no change).
 */
export function estimateTokens(text: string, calibrationPermille = 1000): number {
  if (text.length === 0) return 0;
  const milli = Math.floor((totalMilli(text) * calibrationPermille) / 1000);
  return Math.ceil(milli / 1000);
}

/** As `estimateTokens`, but the caller says what the text is (e.g. serialized tool definitions). */
export function estimateTokensAs(text: string, kind: ContentKind, calibrationPermille = 1000): number {
  if (text.length === 0) return 0;
  const milli = Math.floor((totalMilli(text, kind) * calibrationPermille) / 1000);
  return Math.ceil(milli / 1000);
}

/**
 * Characters per token for sizing budgets the other way round (tokens → characters). Deliberately
 * the cautious, code-and-logs figure: a budget that is too small wastes a little, one that is too
 * big overflows the model.
 */
export const AGENT_CHARS_PER_TOKEN: number = weights.agentCharsPerToken;
