/**
 * Clipboard history — the last few things copied, kept ONLY in memory.
 *
 * What this is careful about, because the clipboard is where passwords, tokens and card
 * numbers pass through:
 *  - It is opt-in (the host only feeds it while the person has switched it on).
 *  - It lives in memory and nowhere else: never written to storage, never sent to a model,
 *    gone when Atlas quits, cleared when it is switched off.
 *  - Anything that looks like a secret is never kept at all (`looksSensitive`). That check is
 *    deliberately eager: a false alarm loses a clipboard entry, a miss leaks a password.
 *  - Big blobs are not kept, and neither are empty or whitespace-only copies.
 */

export const HISTORY_LIMIT = 20;
export const MAX_ENTRY_CHARS = 4000;

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // private keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/, // JWTs
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9]{16,}/i, // API keys (sk-…, sk_live_…)
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/, // Authorization headers
  /\b(?:password|passwd|pwd|passphrase|secret|token|api[\s_-]?key|apikey|auth[\s_-]?key|private[\s_-]?key|credentials?)\b\s*[:=]/i, // key: value pairs
  /\b[A-Za-z0-9._%+-]+:[^\s:@/]{3,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // user:pass@host
  /\b\d{3}-\d{2}-\d{4}\b/, // US social security number
];

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Shannon entropy per character — high for random keys, low for ordinary words. */
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

/** True when copying this looks like copying a secret. Eager on purpose. */
export function looksSensitive(text: string): boolean {
  const t = text.trim();
  if (PATTERNS.some((re) => re.test(t))) return true;

  // A card number: 13–19 digits (spaces or dashes allowed) that pass the Luhn check.
  const digits = t.replace(/[\s-]/g, '');
  if (/^\d{13,19}$/.test(digits) && luhn(digits)) return true;

  // One long unbroken string that is mostly random: a key, a hash, a token.
  if (!/\s/.test(t) && t.length >= 20 && !/^https?:\/\//i.test(t) && !/^[A-Za-z]:[\\/]/.test(t)) {
    const hasDigit = /\d/.test(t);
    const hasLetter = /[A-Za-z]/.test(t);
    if ((hasDigit && hasLetter && entropy(t) > 3.4) || /^[0-9a-f]{32,}$/i.test(t) || /^[A-Za-z0-9+/_-]{32,}={0,2}$/.test(t)) return true;
  }
  return false;
}

export interface ClipboardEntry {
  text: string;
  /** Epoch ms. */
  at: number;
}

export class ClipboardHistory {
  private items: ClipboardEntry[] = [];
  private last: string | null = null;

  /**
   * Offer a clipboard value. Returns whether it was kept. A repeat of the last value, a
   * secret, an empty or an oversized copy is not.
   */
  capture(text: string | null | undefined, now = Date.now()): boolean {
    if (typeof text !== 'string') return false;
    if (text === this.last) return false;
    this.last = text;
    if (!text.trim() || text.length > MAX_ENTRY_CHARS || looksSensitive(text)) return false;
    // Copying something already in the list moves it to the top rather than duplicating it.
    this.items = this.items.filter((e) => e.text !== text);
    this.items.unshift({ text, at: now });
    if (this.items.length > HISTORY_LIMIT) this.items.length = HISTORY_LIMIT;
    return true;
  }

  /** Newest first. */
  list(): readonly ClipboardEntry[] {
    return this.items;
  }

  get(n: number): ClipboardEntry | null {
    return this.items[n - 1] ?? null;
  }

  clear(): void {
    this.items = [];
    this.last = null;
  }

  get size(): number {
    return this.items.length;
  }
}
