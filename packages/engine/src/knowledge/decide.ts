/**
 * Choosing how to answer a knowledge question (docs/PLAN-2.0.3.md §K2, §K6): a small table, no model.
 *
 * The rule that shapes it (Brandon's, binding): **a successful knowledge answer never says anything about
 * whether a language model is available.** If Atlas can answer from what it knows, the model is irrelevant to
 * that reply. The model is mentioned only when the person asks about it, or when what was asked genuinely
 * needs one and none can be reached.
 */

import type { Intent } from './intent';
import { plainText } from './plain';
import { tokenize } from './search';
import type { FaqMatch } from './faq';
import type { KnowledgeHit } from './types';

export type Confidence = 'high' | 'medium' | 'low';

/** How sure we are that the best chunk is really about the question. Thresholds were set against the real pack. */
export function confidenceOf(hits: KnowledgeHit[]): Confidence {
  const top = hits[0];
  if (!top) return 'low';
  const coverage = top.coverage ?? 0;
  // Developer documentation (internals, READMEs) is searched but never offered as a direct answer: at best it is
  // "the closest thing I have". User documentation and reviewed answers are what a person should be told.
  if (top.chunk.audience === 'developer') return coverage >= 0.5 && top.score >= 2.5 ? 'medium' : 'low';
  if (coverage >= 0.8 && top.score >= 4) return 'high';
  if (coverage >= 0.5 && top.score >= 2.5) return 'medium';
  return 'low';
}

export type LiveSourceId =
  | 'atlas-release'
  | 'replay-release'
  | 'nova-cut-release'
  | 'site-nova'
  | 'site-atlas'
  | 'site-replay'
  | 'site-nova-cut'
  | 'site-help'
  | 'site-review'
  | 'site-legal';

const RELEASE_SOURCE: Record<string, LiveSourceId> = {
  atlas: 'atlas-release',
  'replay-gg': 'replay-release',
  'nova-cut': 'nova-cut-release',
};
const SITE_SOURCE: Record<string, LiveSourceId> = {
  nova: 'site-nova',
  atlas: 'site-atlas',
  'replay-gg': 'site-replay',
  'nova-cut': 'site-nova-cut',
  'nova-help': 'site-help',
  'nova-review': 'site-review',
  'nova-legal': 'site-legal',
};

/** The live page that would answer a "current" question about this product, if there is one. */
export function liveSourceFor(intent: Intent): LiveSourceId | null {
  if (!intent.current || !intent.product) return null;
  const releases = /\b(?:new|changed|release|version|latest|newest|changelog|notes)\b/.test(intent.text);
  if (releases && RELEASE_SOURCE[intent.product]) return RELEASE_SOURCE[intent.product] as LiveSourceId;
  return SITE_SOURCE[intent.product] ?? null;
}

export type Plan =
  /** Try the live page first; the caller falls back to the pack (labelled possibly out of date) if it fails. */
  | { kind: 'live'; source: LiveSourceId }
  /** A reviewed answer. No model call, even when one is connected: the verified text beats a paraphrase. */
  | { kind: 'template'; faq: FaqMatch }
  /** The documentation's own words, verbatim, with a source line. `needsModel` adds the one honest line. */
  | { kind: 'passages'; hits: KnowledgeHit[]; needsModel: boolean; partial: boolean }
  /** A connected model answers from the passages, inside the reference block. */
  | { kind: 'model'; hits: KnowledgeHit[]; partial: boolean }
  /** Not covered: leave it to the rest of Atlas (web search, a model, or the honest "not in my documentation"). */
  | { kind: 'decline' };

export interface DecideInput {
  intent: Intent;
  hits: KnowledgeHit[];
  faq: FaqMatch | null;
  modelUsable: boolean;
  liveAllowed: boolean;
}

export function decide({ intent, hits, faq, modelUsable, liveAllowed }: DecideInput): Plan {
  const live = liveAllowed ? liveSourceFor(intent) : null;
  if (live) return { kind: 'live', source: live };
  // A reviewed answer is the best answer to a plain question. A question that needs judgement (why, compare,
  // should I) is not what the entry was written for, so it goes to the passages / a model instead.
  if (faq && !intent.needsReasoning) return { kind: 'template', faq };

  const confidence = confidenceOf(hits);
  if (confidence === 'low') return { kind: 'decline' };
  // Developer documentation is never shown as an answer by itself (it is written for the people who build Atlas,
  // and raw quotes from it mislead). A connected model may still read it, inside the reference block.
  if (hits[0]?.chunk.audience === 'developer' && !modelUsable) return { kind: 'decline' };
  const top = hits.slice(0, confidence === 'high' ? 2 : 3);
  const partial = confidence === 'medium';
  if (intent.needsReasoning) {
    return modelUsable ? { kind: 'model', hits: top, partial } : { kind: 'passages', hits: top, needsModel: true, partial };
  }
  // A medium match with a model: let it read the passages and answer, labelled as partly from the docs.
  if (partial && modelUsable) return { kind: 'model', hits: top, partial };
  return { kind: 'passages', hits: top, needsModel: false, partial };
}

// ---- wording the person sees (all built here, not by a model) ------------------------------------

/** A passage trimmed at a sentence boundary, never mid-word. */
export function excerpt(text: string, max = 650): string {
  const flat = text.replace(/\n{3,}/g, '\n\n').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('\n\n'));
  return `${(stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '')).trim()}…`;
}

/** The few sentences of a chunk that best match the question, so the answer starts where it is relevant. */
export function relevantWindow(text: string, question: string, max = 650): string {
  return windowWithOverlap(text, question, max).text;
}

/** The best window of a chunk, and how many distinct words of the question it contains (0 if the question has none). */
export function windowWithOverlap(
  text: string,
  question: string,
  max = 650,
  /** The chunk's own heading is about the question, so its opening is the answer: start there, not mid-section. */
  fromStart = false,
): { text: string; overlap: number } {
  const clean = plainText(text);
  const q = new Set(tokenize(question));
  const sentences = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (q.size === 0) return { text: excerpt(clean, max), overlap: 0 };
  let best = 0;
  let bestScore = -1;
  const last = fromStart ? 1 : Math.max(1, sentences.length - 2);
  for (let i = 0; i < last; i++) {
    const score = new Set(tokenize(sentences.slice(i, i + 3).join(' ')).filter((t) => q.has(t))).size;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return { text: excerpt(sentences.slice(best, best + 3).join(' '), max), overlap: Math.max(0, bestScore) };
}

export function passagesText(hits: KnowledgeHit[], partial: boolean, question = ''): string {
  const body = hits
    .map((h) => relevantWindow(h.chunk.text, question))
    .filter(Boolean)
    .join('\n\n');
  return partial ? `Here is the closest thing I have:\n\n${body}` : body;
}

/** The one place a missing model is mentioned in a knowledge reply: the question needs one and there is none. */
export const NEEDS_MODEL_LINE = "Going further than that needs a language model, which isn't connected.";

/** Nothing in the documentation covers it, and no model is connected. */
export function notInDocsNoModel(canSearch: boolean): string {
  return canSearch
    ? "That isn't in my documentation, so I can't answer it from what's built in. I can search the web if you'd like (say “search the web for …”)."
    : "That isn't in my documentation, so I can't answer it from what's built in.";
}

/** Nothing in the documentation covers it, and the model that is connected could not be reached. */
export function notInDocsModelUnreachable(why: string): string {
  return `I couldn't reach your language model${why ? ` (${why})` : ''}, and my documentation doesn't cover this.`;
}

/** The "live" label under an answer read from a public page. */
export function liveLine(label: string, url: string, fetchedAtMs: number): string {
  const when = new Date(fetchedAtMs).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  return `Live from ${label} (${url}), read ${when}. This is the page as it is now, not checked against Atlas's signed copy.`;
}
