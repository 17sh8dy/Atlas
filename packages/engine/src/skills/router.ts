/**
 * The capability router: which of Atlas's skills are worth considering for a request.
 *
 * One small, deterministic function — BM25 over each skill's own text — used wherever a
 * request has to be matched against the catalog: trimming the catalog sent to a planner, and
 * answering "do you have something for…". It needs no model, no embeddings and no data file,
 * runs in well under a millisecond per skill, and gives the same answer for the same input,
 * which is what lets a test assert it.
 *
 * What it ranks on, and why those weights: a skill's label and id say what it IS, so a hit
 * there outweighs a passing mention in its description; its examples are phrasings people
 * actually type, so they count more than prose. A query word matches a skill word when they are
 * the same word after light stemming, or when the skill word merely extends it ("zip" finds
 * "zipping" and "unzip" is a different word — prefix, not substring — so "sip" cannot find
 * "description").
 *
 * What it does not do: understand a request. It narrows a list. The planner, a grammar rule or
 * the person still decides; an empty result is "nothing here matches", never a guess.
 */

import type { Skill } from '@atlas/core';

/** BM25 saturation and length-normalisation constants (the usual defaults). */
const K1 = 1.2;
const B = 0.75;

/** A hit in a field counts this many times. */
const FIELD_WEIGHT = { label: 3, id: 2, examples: 1.5, description: 1 } as const;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'please', 'can', 'you',
  'my', 'me', 'to', 'of', 'in', 'on', 'it', 'a', 'an', 'is', 'are', 'all', 'some', 'then',
  'do', 'does', 'how', 'what', 'about', 'any', 'anything', 'thing', 'things',
]);

/** Lower-case words; camelCase and dotted ids are split; stop words and 1-letter words dropped. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  for (const raw of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP_WORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** "zipping", "zipped", "zips" and "zip" meet at one form. Deliberately crude: precision comes from BM25. */
function stem(word: string): string {
  if (word.length <= 3) return word;
  let w = word;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1);
  // "zipping" -> "zipp": undo a doubled final consonant so it lands on "zip".
  return /([b-df-hj-np-tv-z])\1$/.test(w) && w.length > 3 ? w.slice(0, -1) : w;
}

interface Doc {
  terms: Map<string, number>;
  length: number;
}

function buildDoc(skill: Skill): Doc {
  const terms = new Map<string, number>();
  let length = 0;
  const add = (text: string, weight: number) => {
    for (const t of tokenize(text)) {
      terms.set(t, (terms.get(t) ?? 0) + weight);
      length += weight;
    }
  };
  add(skill.label, FIELD_WEIGHT.label);
  add(skill.id, FIELD_WEIGHT.id);
  add((skill.examples ?? []).join(' '), FIELD_WEIGHT.examples);
  add(skill.description, FIELD_WEIGHT.description);
  return { terms, length };
}

/** A query term matches a document term when they are equal, or the document term extends it. */
function termFrequency(doc: Doc, term: string): number {
  const exact = doc.terms.get(term);
  if (exact) return exact;
  if (term.length < 4) return 0;
  let best = 0;
  for (const [t, n] of doc.terms) if (t.length > term.length && t.startsWith(term)) best = Math.max(best, n);
  // An extension is a weaker match than the word itself.
  return best * 0.6;
}

export interface ScoreOptions {
  /** Extra weight for a skill, added after ranking — a usage prior, say. Never makes a non-match match. */
  boost?(skill: Skill): number;
}

/**
 * A score for every skill, in the order given. 0 means no query word matched.
 * Scores are comparable within one call, not across calls.
 */
export function scoreSkills(skills: readonly Skill[], query: string, options: ScoreOptions = {}): number[] {
  const words = [...new Set(tokenize(query))];
  if (!words.length || !skills.length) return skills.map(() => 0);

  const docs = skills.map(buildDoc);
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;

  // Document frequency per query word, over the skills actually being ranked.
  const idf = new Map<string, number>();
  for (const w of words) {
    const n = docs.filter((d) => termFrequency(d, w) > 0).length;
    idf.set(w, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)));
  }

  return docs.map((doc, i) => {
    let score = 0;
    for (const w of words) {
      const tf = termFrequency(doc, w);
      if (!tf) continue;
      score += (idf.get(w) ?? 0) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.length / avg))));
    }
    return score > 0 ? score + Math.max(0, options.boost?.(skills[i]!) ?? 0) : 0;
  });
}

export interface RankedSkill {
  skill: Skill;
  score: number;
}

/** The skills that match, best first; ties keep registration order. */
export function rankSkills(
  skills: readonly Skill[],
  query: string,
  options: ScoreOptions & { limit?: number } = {},
): RankedSkill[] {
  const scores = scoreSkills(skills, query, options);
  const ranked = skills
    .map((skill, order) => ({ skill, order, score: scores[order]! }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ skill, score }) => ({ skill, score }));
  return options.limit ? ranked.slice(0, options.limit) : ranked;
}
