/**
 * The knowledge tier's brain (docs/PLAN-2.0.3.md §K): given a question and what Atlas has, work out the
 * reply. Pure apart from the dependencies it is handed, so the whole matrix of situations (model on, off,
 * unreachable; online, offline; documented, not documented) is testable without an app.
 *
 * It returns a description, never speaks: the engine decides how to say it. Nothing here executes anything
 * or calls a tool. Everything it shows a person is built in code from verified text or labelled live text.
 */

import { decide, excerpt, liveLine, windowWithOverlap, NEEDS_MODEL_LINE, type LiveSourceId } from './decide';
import { compareVersions, matchFaq, type Facts, type FaqEntry } from './faq';
import { plainText } from './plain';
import { classifyIntent, type Intent } from './intent';
import { referenceBlock, sourceLine, sourceLinks } from './cite';
import { contentTokens, tokenize, type KnowledgeIndex } from './search';
import type { KnowledgeChunk, KnowledgeHit, PackInfo } from './types';

/** What the engine needs to hand over. */
export interface LoadedKnowledge {
  info: PackInfo;
  index: KnowledgeIndex;
  faq: FaqEntry[];
}

/** One live reading: unsigned text from a public page, with where and when. */
export interface LiveReading {
  label: string;
  url: string;
  fetchedAtMs: number;
  title: string;
  published: string | null;
  text: string;
  thin: boolean;
  isRelease: boolean;
}

export interface KnowledgeDeps {
  load(): Promise<LoadedKnowledge | null>;
  /** Read a public page live. Rejects or returns null when lookups are off or the page cannot be read. */
  live?(id: LiveSourceId): Promise<LiveReading | null>;
  liveAllowed(): boolean;
  /** Is the daily refresh on? An old pack is only called out-of-date when it is not. */
  refreshing(): boolean;
  /** The running Atlas version (`2.0.3`), so a verified answer about a newer feature is not used. */
  runningVersion: string;
  /** Live facts a verified answer may quote. */
  facts(): Facts;
  now?(): number;
}

export type KnowledgeReply =
  /** Answered. `text` is the whole reply, source line included. */
  | { kind: 'say'; text: string; links: Array<{ label: string; url: string }>; how: 'verified' | 'passages' | 'live' }
  /** A connected model answers from the passages. `body` is the prompt; `footer` is appended to its reply. */
  | { kind: 'ask-model'; body: string; footer: string; fallback: string }
  /** Not covered: carry on with the rest of Atlas. */
  | { kind: 'none'; intent: Intent };

const SENTENCE = /(?<=[.!?])\s+|\n+/;

/** The part of a live page that best matches the question: a few overlapping sentences, not the whole page. */
export function bestLiveExcerpt(text: string, question: string, max = 600): string {
  const q = new Set(tokenize(question));
  const sentences = text.split(SENTENCE).map((s) => s.trim()).filter((s) => s.length > 20);
  if (sentences.length === 0) return excerpt(text, max);
  let bestAt = 0;
  let bestScore = -1;
  for (let i = 0; i < sentences.length; i++) {
    const window = sentences.slice(i, i + 3).join(' ');
    const score = tokenize(window).filter((t) => q.has(t)).length;
    if (score > bestScore) {
      bestScore = score;
      bestAt = i;
    }
  }
  return excerpt(sentences.slice(bestAt, bestAt + 3).join(' '), max);
}

export async function answerKnowledge(question: string, deps: KnowledgeDeps, opts: { modelUsable: boolean }): Promise<KnowledgeReply> {
  const intent = classifyIntent(question);
  if (!intent.isKnowledgeQuestion) return { kind: 'none', intent };

  const loaded = await deps.load();
  const hits: KnowledgeHit[] = loaded ? loaded.index.search(intent.text, { limit: 5 }) : [];
  const faq = loaded ? matchFaq(loaded.faq, intent.text, deps.runningVersion, deps.facts()) : null;
  const plan = decide({ intent, hits, faq, modelUsable: opts.modelUsable, liveAllowed: deps.liveAllowed() && Boolean(deps.live) });
  const now = deps.now?.() ?? Date.now();


  if (plan.kind === 'live') {
    let reading: LiveReading | null = null;
    try {
      reading = (await deps.live?.(plan.source)) ?? null;
    } catch {
      reading = null;
    }
    if (reading && !reading.thin) {
      const body = reading.isRelease
        ? `${reading.title}${reading.published ? `, published ${reading.published.slice(0, 10)}` : ''}\n\n${excerpt(reading.text, 1200)}`
        : bestLiveExcerpt(reading.text, intent.text);
      return {
        kind: 'say',
        how: 'live',
        text: `${body}\n\n${liveLine(reading.label, reading.url, reading.fetchedAtMs)}`,
        links: [{ label: reading.label, url: reading.url }],
      };
    }
    // The page could not be read (offline, off, or script-only): fall back to the pack, and say it may be stale.
    return packAnswer(intent, hits, faq, loaded, deps, opts, now, true);
  }
  return packAnswer(intent, hits, faq, loaded, deps, opts, now, false);
}

function packAnswer(
  intent: Intent,
  hits: KnowledgeHit[],
  faq: ReturnType<typeof matchFaq>,
  loaded: LoadedKnowledge | null,
  deps: KnowledgeDeps,
  opts: { modelUsable: boolean },
  now: number,
  liveFailed: boolean,
): KnowledgeReply {
  if (!loaded) return { kind: 'none', intent };
  const plan = decide({ intent: { ...intent, current: false }, hits, faq, modelUsable: opts.modelUsable, liveAllowed: false });
  // A "current" question the page could not answer from live: the pack answers, flagged, because it may be old.
  const stale = liveFailed ? ' · may be out of date: I could not read the live page just now' : '';
  const line = (h: KnowledgeHit[]) => `${sourceLine({ hits: h, pack: loaded.info, now, refreshing: deps.refreshing() })}${stale}`;

  // "What's new" when the live page could not be read (or lookups are off): the newest release notes in the pack,
  // flagged because a newer release may exist.
  if (intent.current && intent.product && /\b(?:new|changed|release|latest|newest|changelog|notes)\b/.test(intent.text)) {
    const notes = latestReleaseNotes(loaded, intent.product);
    if (notes) {
      const h = [{ chunk: notes, score: 1 }];
      const stale = ' · may be out of date: I could not read the live page just now';
      const flag = liveFailed ? stale : ' · this is the newest release in my built-in documentation; a newer one may exist';
      return {
        kind: 'say',
        how: 'passages',
        text: `${notes.title}

${excerpt(plainText(notes.text), 900)}

${sourceLine({ hits: h, pack: loaded.info, now, refreshing: deps.refreshing() })}${flag}`,
        links: sourceLinks(h),
      };
    }
  }

  if (plan.kind === 'template') {
    const h = [{ chunk: plan.faq.entry.chunk, score: 1 }];
    return { kind: 'say', how: 'verified', text: `${plan.faq.text}\n\n${line(h)} · Verified answer`, links: sourceLinks(h) };
  }
  if (plan.kind === 'passages') {
    const shown = showable(plan.hits, intent, loaded.index);
    if (shown.length === 0) return { kind: 'none', intent };
    const more = plan.needsModel ? `\n\n${NEEDS_MODEL_LINE}` : '';
    const hits = shown.map((k) => k.h);
    const body = shown.map((k) => k.text).join('\n\n');
    const lead = plan.partial ? 'Here is the closest thing I have:\n\n' : '';
    return { kind: 'say', how: 'passages', text: `${lead}${body}${more}\n\n${line(hits)}`, links: sourceLinks(hits) };
  }
  if (plan.kind === 'model') {
    const body = `${referenceBlock(plan.hits)}\n\nAnswer the question using only the reference material above. If it does not say, say that it does not.\n\nQuestion: ${intent.text}`;
    const footer = `\n\n${line(plan.hits)}${plan.partial ? ' · partly from the documentation' : ''}`;
    // If the model cannot answer, the documentation answers only if it really has something to show; otherwise
    // there is no fallback, and the engine says honestly that the model could not be reached and the docs do not cover it.
    const shown = showable(plan.hits, intent, loaded.index);
    const fallback = shown.length
      ? `${plan.partial ? 'Here is the closest thing I have:\n\n' : ''}${shown.map((k) => k.text).join('\n\n')}\n\n${line(shown.map((k) => k.h))}`
      : '';
    return { kind: 'ask-model', body, footer, fallback };
  }
  return { kind: 'none', intent };
}

/** The release notes for a product with the highest version, if the pack has any. */
function latestReleaseNotes(loaded: LoadedKnowledge, product: string): KnowledgeChunk | null {
  const candidates = loaded.index.findByTitle(/release notes/i, product);
  let best: KnowledgeChunk | null = null;
  let bestV = '0.0.0';
  for (const c of candidates) {
    const v = /(\d+\.\d+\.\d+)/.exec(c.title)?.[1];
    if (v && (best === null || compareVersions(v, bestV) > 0)) {
      best = c;
      bestV = v;
    }
  }
  return best;
}

/**
 * The passages worth showing a person, as plain text. Only a chunk whose best sentences actually contain what was
 * asked is shown: one that matched on a stray word is not an answer, and showing it would be worse than saying
 * nothing. One content word beside a product name is weak evidence (any chunk mentions "computer"), so it only
 * counts when the section's own heading is about it too.
 */
function showable(hits: KnowledgeHit[], intent: Intent, index: KnowledgeIndex): Array<{ h: KnowledgeHit; text: string }> {
  const content = contentTokens(intent.text);
  const asked = content.length;
  // The question's most telling word must be in what is shown, or it is not an answer to THIS question.
  const key = index.rarest(content);
  // When half or more of what was asked is a word the documentation never uses ("Linux"), it is not about what is
  // documented, however well the other words match.
  if (asked > 0 && index.unknownCount(content) * 2 >= asked) return [];
  const need = asked === 0 ? 0 : Math.max(1, Math.ceil(asked * 0.5));
  const top = hits[0]?.score ?? 0;
  const out: Array<{ h: KnowledgeHit; text: string }> = [];
  for (const h of hits) {
    if (h.score < top * 0.8) continue;
    // Developer documentation is for a model to read, never for a person to be shown as an answer.
    if (h.chunk.audience === 'developer') continue;
    // The section's heading names what was asked: it is that section, so read it from its opening.
    const headingIsAbout = tokenize(h.chunk.headingPath[h.chunk.headingPath.length - 1] ?? '').some((t) => content.includes(t));
    const w = windowWithOverlap(h.chunk.text, intent.text, 650, headingIsAbout);
    if (w.text.length === 0) continue;
    // (The word may be in the section's heading rather than its sentences: that is the section being about it.)
    if (key && !tokenize(w.text).includes(key) && !tokenize(h.chunk.headingPath.join(' ')).includes(key)) continue;
    if (!(asked >= 2 || headingIsAbout || asked === 0)) continue;
    if (w.overlap < (headingIsAbout ? Math.min(need, 1) : need)) continue;
    out.push({ h, text: w.text });
  }
  return out;
}
