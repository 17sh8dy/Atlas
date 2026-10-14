/**
 * Keeping credentials out of anything Atlas writes down.
 *
 * Atlas's own keys rest in Windows Credential Manager and nowhere else. This is the belt to that
 * braces: text about to be **persisted** (the conversation history, notes the person asked Atlas to
 * remember) passes through `redactSecrets`, so a key someone pasted into the chat is not kept in
 * a plain JSON file. It is the TypeScript twin of `redact.rs` and deliberately eager: a lost
 * identifier is cheap, a kept key is not.
 *
 * Tokens are judged whole, so ordinary words, Windows paths and SHA-256 digests are untouched.
 */

export const KEY_HIDDEN = '[key hidden]';

const PREFIXED =
  /\b(?:sk[-_][A-Za-z0-9_-]{16,}|[pr]k_[A-Za-z0-9_]{16,}|hf_[A-Za-z0-9]{20,}|tvly-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
const NAMED =
  /\b((?:x-goog-api-key|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|passwd|pwd|secret|token)\s*[:=]\s*)(?:"[^"\s]+"|'[^'\s]+'|[^\s"',;]+)/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const LONG = /[A-Za-z0-9_+/=-]{32,}/g;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A long, mixed-case, digit-bearing, high-entropy run that is not a hex digest. */
function looksRandom(t: string): boolean {
  if (/^[0-9a-fA-F]+$/.test(t)) return false;
  if (!/[a-z]/.test(t) || !/[A-Z]/.test(t) || !/\d/.test(t)) return false;
  return entropy(t) >= 3.5;
}

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text.replace(PRIVATE_KEY, KEY_HIDDEN);
  out = out.replace(PREFIXED, KEY_HIDDEN).replace(JWT, KEY_HIDDEN);
  out = out.replace(BEARER, `$1${KEY_HIDDEN}`);
  out = out.replace(NAMED, `$1${KEY_HIDDEN}`);
  // Last, and per run: paths and URLs are split on `/` first so their length is not mistaken for
  // randomness.
  out = out.replace(LONG, (run) => {
    if (run.includes(KEY_HIDDEN)) return run;
    if (run.includes('/')) {
      return run
        .split('/')
        .map((seg) => (seg.length >= 32 && looksRandom(seg) ? KEY_HIDDEN : seg))
        .join('/');
    }
    return looksRandom(run) ? KEY_HIDDEN : run;
  });
  return out;
}
