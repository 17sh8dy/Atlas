/**
 * What was pasted, and what to do about it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Tavily's dashboard shows a real key (`tvly-…`) and, next to it, longer
 * things that *contain* one: a connection link with the key in its query
 * string, a code snippet. Pasting one of those into a key field saves a 99
 * character link that Tavily answers with 401 — and because a failed search
 * quietly falls back to another engine, nothing looked wrong except that the
 * answers were not what a working key would give.
 *
 * So the field takes a key out of whatever was pasted when there is one in it,
 * says so plainly when there is not, and — after saving — asks Tavily whether
 * it works, and reports the answer in words.
 */

/** Tavily keys are `tvly-` followed by letters, digits, `_` or `-`. */
const KEY = /tvly-[A-Za-z0-9_-]{8,}/;

export type PastedKey =
  { ok: true; key: string; extracted: boolean } | { ok: false; message: string };

export function readPastedKey(input: string): PastedKey {
  const text = input.trim();
  if (!text) return { ok: false, message: 'Paste your Tavily key first.' };

  const found = KEY.exec(text);
  if (found) return { ok: true, key: found[0], extracted: found[0] !== text };

  const looksLikeALink = text.includes('://') || /\s/.test(text) || text.length > 200;
  return {
    ok: false,
    message: looksLikeALink
      ? 'That looks like a link or a block of text, not a key. A Tavily key is one short line that starts with “tvly-” — copy just that from the API Keys page of your Tavily dashboard.'
      : 'That doesn’t look like a Tavily key. They start with “tvly-”.',
  };
}

export type KeyCheck = { tone: 'good' | 'bad' | 'neutral'; message: string };

/** `error` is what the failed test search rejected with, or `undefined` if it worked. */
export function describeKeyCheck(error: string | undefined): KeyCheck {
  if (error === undefined) return { tone: 'good', message: 'Tavily accepted the key — it works.' };
  const kind = /^\s*(quota|auth|rate|blocked|offline|error)\s*:/i.exec(error)?.[1]?.toLowerCase();
  switch (kind) {
    case 'auth':
      return {
        tone: 'bad',
        message:
          'Tavily rejected this key. Copy it again from the API Keys page of your Tavily dashboard and paste it here.',
      };
    case 'quota':
      return {
        tone: 'neutral',
        message: 'Tavily accepted the key, but its free searches are used up for now.',
      };
    case 'rate':
      return {
        tone: 'neutral',
        message: 'Tavily is busy right now. The key is saved — Atlas will try again on its own.',
      };
    case 'offline':
      return {
        tone: 'neutral',
        message: 'Couldn’t reach Tavily to check it. The key is saved; check your connection.',
      };
    default:
      return {
        tone: 'neutral',
        message: 'The key is saved, but Tavily’s check didn’t come back cleanly. Try a search.',
      };
  }
}
