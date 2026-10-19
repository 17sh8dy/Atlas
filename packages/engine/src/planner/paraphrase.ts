/**
 * Other ways of saying what the grammar already understands.
 *
 * The grammar is anchored on purpose: "open X" must not claim "remind me not to open X". So a perfectly
 * clear request in an unfamiliar shape ("would you mind opening Steam?", "get Steam running", "okay so,
 * open Steam") misses every rule. `normalizeRequest` already strips greetings and a leading "can you";
 * this layer is the next, smaller step: rewrite the SHAPE of the sentence into one the rules know, and
 * let the same rules run again.
 *
 *   · it only ever runs AFTER the raw text, the filler-stripped text and the typo fix all failed to
 *     match, so it can never change how an already understood sentence behaves (`engine.ts`);
 *   · it adds no rule and decides nothing: it proposes candidate sentences, and the grammar (and then
 *     the content policy, the risk check and the confirmation card) judge them exactly as if the person
 *     had typed the candidate;
 *   · it never drops a meaningful word. Manners come off; "not", "instead", "all", "again" and anything
 *     that might be part of a name stay;
 *   · candidates are returned most-faithful first, and the caller takes the first one a rule accepts.
 *
 * Pure and deterministic: the same sentence always produces the same candidates in the same order.
 */

import { stripFiller } from '../text/normalize';
import { PHRASAL_VERBS, SYNONYM_GROUPS } from '../capabilities/vocabulary';

/** "opening" → "open": the gerunds people use after "would you mind" / "how about". */
const GERUND: Record<string, string> = {
  opening: 'open', launching: 'launch', starting: 'start', closing: 'close', finding: 'find',
  showing: 'show', deleting: 'delete', removing: 'remove', copying: 'copy', moving: 'move',
  renaming: 'rename', running: 'run', checking: 'check', installing: 'install', creating: 'create',
  making: 'make', building: 'build', testing: 'test', searching: 'search', listing: 'list',
  organizing: 'organize', organising: 'organise', zipping: 'zip', unzipping: 'unzip', compressing: 'compress',
  restarting: 'restart', stopping: 'stop', killing: 'kill', playing: 'play', pausing: 'pause',
  typing: 'type', clicking: 'click', pressing: 'press', scrolling: 'scroll', saving: 'save',
  taking: 'take', setting: 'set', turning: 'turn', cleaning: 'clean', comparing: 'compare',
};

/** Verbs whose synonyms may be swapped in for the first word. The first member is what the rules know. */
const SWAPPABLE: readonly (readonly string[])[] = SYNONYM_GROUPS.filter((g) =>
  ['open', 'close', 'find', 'show', 'delete', 'copy', 'move', 'rename', 'create', 'install', 'check', 'restart'].includes(g[0]!),
);

/** First words that mean several different things, so they are never swapped for another verb. */
const AMBIGUOUS_VERBS = new Set([
  'get', 'set', 'make', 'new', 'add', 'keep', 'hold', 'page', 'push', 'record', 'end', 'look', 'input', 'select',
  'choose', 'print', 'clear', 'where', 'see', 'view', 'read', 'write', 'type', 'build', 'test',
]);

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The sentence without its trailing question mark / punctuation and courtesies, then stripped again. */
function bare(text: string): string {
  const noPunct = text.replace(/[\s?.!]+$/g, '').trim();
  return tidy(stripFiller(noPunct).replace(/[\s?.!]+$/g, ''));
}

/**
 * Candidate rewrites of `text`, most faithful first, never including `text` itself.
 */
export function paraphraseCandidates(text: string): string[] {
  const original = tidy(String(text ?? ''));
  if (!original || original.length > 400) return [];
  const out: string[] = [];
  const add = (candidate: string) => {
    const c = tidy(candidate).replace(/[\s?.!,]+$/g, '').trim();
    if (c && c.toLowerCase() !== original.toLowerCase() && !out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
  };

  // 1. The same sentence without its question mark and courtesies ("Can you open Steam for me?").
  const stripped = bare(original);
  add(stripped);

  // 2. Indirect requests: "would you mind opening X", "is it possible to open X", "how about opening X",
  //    "I'd like to open X", "I'd like X open".
  const indirect = [
    /^(?:would|do|could)\s+you\s+mind\s+(\w+ing)\s+(.+)$/i,
    /^(?:is\s+it\s+possible\s+to|are\s+you\s+able\s+to|can\s+you\s+(?:try\s+to|go\s+ahead\s+and))\s+(.+)$/i,
    /^(?:how|what)\s+about\s+(\w+ing)\s+(.+)$/i,
    /^(?:i(?:'|’)?d|i\s+would)\s+like\s+(?:you\s+)?to\s+(.+)$/i,
    /^(?:i(?:'|’)?d|i\s+would)\s+like\s+(.+?)\s+(open|running|started|launched|closed)$/i,
  ];
  // The filler strip can eat the start of "would you mind opening X" (it removes "would you"), so the
  // patterns are tried against both the stripped text and the original with only its ending tidied.
  const light = tidy(original.replace(/[\s?.!]+$/g, ''));
  for (const re of [...indirect, /^mind\s+(\w+ing)\s+(.+)$/i]) {
    const m = re.exec(stripped) ?? re.exec(light);
    if (!m) continue;
    if (m.length === 3 && /ing$/i.test(m[1] ?? '') && GERUND[m[1]!.toLowerCase()]) {
      add(`${GERUND[m[1]!.toLowerCase()]} ${m[2]}`);
    } else if (m.length === 3 && /^(open|running|started|launched|closed)$/i.test(m[2] ?? '')) {
      add(`${/closed/i.test(m[2]!) ? 'close' : 'open'} ${m[1]}`);
    } else if (m[1]) {
      add(m[1]);
    }
  }

  // 3. Phrasal verbs and slang for a simple verb ("fire up", "get X running", "where's X").
  for (const base of [stripped, original]) {
    for (const [re, to] of PHRASAL_VERBS) {
      if (re.test(base)) add(base.replace(re, to));
    }
  }

  // 4. A leading aside and then the instruction: "okay so, open Steam" / "right, launch steam". A clause
  //    that ends in "it" / "that" has no target of its own and is NOT guessed at.
  const afterComma = /^(?:[^,]{1,40}),\s*((?:open|launch|start|run|close|find|show|delete|copy|move|rename|create|install|check|restart)\b.+)$/i.exec(stripped);
  //    (A clause whose OBJECT is a pronoun, "open it up" or "close that", is refused the same way.)
  if (afterComma && !/^\w+\s+(?:it|that|this|them|those|these)\b/i.test(afterComma[1]!) && !/\b(?:it|that|this|them)\s*$/i.test(afterComma[1]!)) {
    add(afterComma[1]!);
  }

  // 5. A different verb for the same instruction: "load steam" / "kill steam" → "open steam" / "close steam".
  //    Only ever the canonical verb of the group, and never from a word that means many things ("get",
  //    "set", "make", "keep"…), so a swap cannot turn one instruction into a different one.
  const first = stripped.split(' ')[0]?.toLowerCase() ?? '';
  const rest = stripped.slice(first.length).trim();
  if (rest && !AMBIGUOUS_VERBS.has(first)) {
    for (const group of SWAPPABLE) {
      if (group.includes(first) && group[0] !== first) add(`${group[0]} ${rest}`);
    }
  }
  return out.slice(0, 12);
}
