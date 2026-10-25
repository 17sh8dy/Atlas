/**
 * Answering a general question with no language model: search, read, pick, and say where it came from.
 *
 * Runs the same research pipeline a model-backed answer would (`gatherEvidence`: DuckDuckGo, Tavily when a
 * key is saved, Wikipedia as the backstop, the top pages read, the sources cross-checked) and then does
 * what the model would have done — choose the sentences that answer — with `composeAnswer`, which can
 * only quote. See compose.ts for why that is the point.
 */

import type { SkillContext, WebSearchResult } from '@atlas/core';
import type { SkillRegistry } from '../skills/registry';
import { extractPassages } from '../web/evidence';
import { gatherEvidence } from '../web/pipeline';
import type { RouteDecision } from '../web/router';
import { composeAnswer, formatComposed, stems, titleFit } from './compose';
import type { QuestionShape } from './shape';

const DECISION: RouteDecision = {
  search: true,
  category: null,
  reason: 'looking it up',
  topic: 'general',
};

/**
 * What to keep from a page: its opening (an encyclopedia's first sentences ARE the definition, and they often
 * do not repeat the words of the question — "Reels is a short-form video feature…" shares no word with
 * "Instagram Reel" before stemming) followed by the passages that share words with the query.
 */
export function leadAndPassages(pageText: string, query: string, maxChars = 1800): string {
  const lead = pageText.trim().slice(0, 900);
  const cut = Math.max(lead.lastIndexOf('. '), lead.lastIndexOf('.\n'));
  const opening = cut > 200 ? lead.slice(0, cut + 1) : lead;
  const rest = extractPassages(
    pageText.slice(opening.length),
    query,
    Math.max(400, maxChars - opening.length),
  );
  return `${opening}\n${rest}`.slice(0, maxChars + 900);
}

export type GeneralResult =
  /** An answer to show. */
  | { kind: 'answer'; text: string }
  /** Searched and read, and nothing in it answered the question. */
  | { kind: 'nothing'; links: string; results: WebSearchResult[] }
  /** No search backend could be reached at all. */
  | { kind: 'unavailable' };

export interface GeneralOptions {
  /** How many of the shape's queries to try before giving up. */
  attempts?: number;
  now?: () => Date;
  /** How long a page may take to read (default 9 s). */
  readTimeoutMs?: number;
  /** Search with these instead of the shape's own (the current-information path uses a date-aware rewrite). */
  queries?: string[];
}

export async function answerGeneral(
  question: string,
  shape: QuestionShape,
  skills: SkillRegistry,
  ctx: SkillContext,
  options: GeneralOptions = {},
): Promise<GeneralResult> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const aboutStems = stems(shape.entity ?? shape.subject);
  const askedStems = stems(
    `${shape.subject} ${shape.context ?? ''} ${shape.entity ?? ''} ${question}`,
  );
  let best: { text: string; rank: number; score: number } | null = null;
  let links = '';
  let found: WebSearchResult[] = [];
  let reached = false;

  for (const query of (options.queries ?? shape.queries).slice(0, attempts)) {
    const research = await gatherEvidence(
      question,
      DECISION,
      skills,
      { ...ctx, showResults: undefined },
      {
        query,
        read: true,
        maxRead: 3,
        ...(options.readTimeoutMs ? { readTimeoutMs: options.readTimeoutMs } : {}),
        prefer: (r) => titleFit(r.title, aboutStems, askedStems),
        excerptChars: 1800,
        excerptOf: leadAndPassages,
        ...(options.now ? { now: options.now } : {}),
      },
    );
    if (research.status === 'unavailable') continue;
    reached = true;
    if (research.status !== 'ok') continue;
    if (!found.length) found = research.results;

    const composed = composeAnswer(research.packet, shape);
    if (!composed) {
      links ||= research.packet.evidence
        .slice(0, 3)
        .map((e) => `• ${e.title.replace(/\s+/g, ' ').trim()} — ${e.url}`)
        .join('\n');
      continue;
    }
    const rank = composed.confidence === 'high' ? 3 : composed.confidence === 'medium' ? 2 : 1;
    if (!best || rank > best.rank || (rank === best.rank && composed.score > best.score)) {
      best = {
        text: formatComposed(research.packet, shape, composed),
        rank,
        score: composed.score,
      };
    }
    if (rank === 3) break;
  }

  if (best) return { kind: 'answer', text: best.text };
  return reached ? { kind: 'nothing', links, results: found } : { kind: 'unavailable' };
}

/** What to say when the web was searched and nothing answered. Names what was done, not a missing model. */
export function nothingFoundText(links: string): string {
  return links
    ? `I searched, but nothing I read answered that clearly. These looked closest:\n${links}`
    : "I searched, but couldn't find a page that answers that.";
}
