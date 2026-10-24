/**
 * Verified answers (docs/PLAN-2.0.3.md §K4): short, reviewed answers to the questions people actually ask,
 * written from the documentation and approved by a person before they ship. They arrive inside the signed
 * pack as chunks with `origin: 'faq'`.
 *
 * Matching is deterministic: the question must contain every meaningful word of one of an entry's `match`
 * phrases (after the same light stemming the search uses). The longest phrase that matches wins; two
 * different entries matching equally is ambiguous and neither answers (the tier falls back to search).
 *
 * An answer may contain `{placeholders}` for facts that must be true *now* (how many things Atlas can do,
 * whether refresh is on, the pack's date). They are filled from live state at answer time; if one cannot be
 * filled, the entry declines rather than saying something it cannot stand behind. An entry also carries the
 * first version that has the feature (`since`), and is not used by an older Atlas.
 */

import { tokenize } from './search';
import type { KnowledgeChunk } from './types';

export interface FaqEntry {
  id: string;
  topic: string;
  aspects: string[];
  /** Seed phrases. The question only needs to contain the words of one. */
  match: string[];
  /** The reviewed answer, with optional `{placeholders}`. */
  answer: string;
  /** First Atlas version that has what the answer describes. */
  since: string;
  chunk: KnowledgeChunk;
}

/** Live facts an answer may use. Anything not in the map cannot be used. */
export type Facts = Record<string, string | number | boolean | undefined>;

export function faqEntries(chunks: KnowledgeChunk[]): FaqEntry[] {
  const out: FaqEntry[] = [];
  for (const c of chunks) {
    if (c.origin !== 'faq' || !c.faq) continue;
    out.push({ id: c.id, topic: c.faq.topic, aspects: c.faq.aspects, match: c.faq.match, answer: c.text, since: c.faq.since, chunk: c });
  }
  return out;
}

/** -1, 0, 1. Versions are `major.minor.patch`; anything unparseable compares as older (so it is not used). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/** The answer with every placeholder filled, or null if any cannot be: an answer with a hole is not given. */
export function fillAnswer(answer: string, facts: Facts): string | null {
  let missing = false;
  const text = answer.replace(PLACEHOLDER, (_, name: string) => {
    const v = facts[name];
    if (v === undefined || v === '') {
      missing = true;
      return '';
    }
    return typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v);
  });
  return missing ? null : text;
}

export interface FaqMatch {
  entry: FaqEntry;
  text: string;
}

/**
 * The entry that answers `question`, if exactly one clearly does. `runningVersion` keeps an entry about a
 * feature this install lacks from being used; `facts` fills its placeholders.
 */
export function matchFaq(entries: FaqEntry[], question: string, runningVersion: string, facts: Facts): FaqMatch | null {
  const q = new Set(tokenize(question));
  if (q.size === 0) return null;
  let best: { entry: FaqEntry; words: number } | null = null;
  let tied = false;
  for (const entry of entries) {
    if (compareVersions(runningVersion, entry.since) < 0) continue;
    let words = 0;
    for (const phrase of entry.match) {
      const p = [...new Set(tokenize(phrase))];
      if (p.length > 0 && p.every((t) => q.has(t))) words = Math.max(words, p.length);
    }
    if (words === 0) continue;
    if (!best || words > best.words) {
      best = { entry, words };
      tied = false;
    } else if (words === best.words && entry.id !== best.entry.id) {
      tied = true;
    }
  }
  if (!best || tied) return null;
  const text = fillAnswer(best.entry.answer, facts);
  return text === null ? null : { entry: best.entry, text };
}
