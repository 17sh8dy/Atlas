/**
 * Web research, end to end:
 *
 *   route → rewrite → search (manager) → choose sources → read pages
 *         → verify → evidence packet
 *
 * Every step that touches the network goes through the skill registry — the
 * same single door every other action uses — so the content filter, the
 * platform gate and the activity log apply here exactly as they do to a
 * command the user typed. Nothing in this file evaluates or executes any of
 * what a page says; it only reads it.
 *
 * The pipeline stops at an `EvidencePacket`. What to *say* about it is the
 * caller's business (a model, or just the result rows), which is what keeps
 * the search side replaceable without touching the model side and the other
 * way round.
 */

import type { SkillContext, WebPage, WebSearchResult } from '@atlas/core';
import type { SkillRegistry } from '../skills/registry';
import {
  buildPacket,
  registrableDomain,
  hostOf,
  type EvidenceInput,
  type EvidencePacket,
} from './evidence';
import { rewriteQuery } from './query';
import type { RouteDecision } from './router';

export interface ResearchOptions {
  now?: () => Date;
  /** Sources handed onward. */
  maxSources?: number;
  /** Of those, how many pages are actually fetched and read. */
  maxRead?: number;
  readTimeoutMs?: number;
  /** False when nothing will use the page text (no model connected): search only. */
  read?: boolean;
}

export type ResearchResult =
  | { status: 'ok'; packet: EvidencePacket; results: WebSearchResult[] }
  /** No search backend could answer. Not an error to show the user as one. */
  | { status: 'unavailable' }
  | { status: 'no-results' };

const DEFAULTS = { maxSources: 5, maxRead: 3, readTimeoutMs: 9000 };

/**
 * Prefer one result per site first, then fill up in rank order. Five results
 * from one wiki are one opinion; the point of reading several is to hear from
 * different places.
 */
export function chooseSources(results: WebSearchResult[], limit: number): WebSearchResult[] {
  const seenUrl = new Set<string>();
  const unique = results.filter((r) => {
    if (!r.url || seenUrl.has(r.url)) return false;
    seenUrl.add(r.url);
    return true;
  });
  const seenSite = new Set<string>();
  const firstPerSite: WebSearchResult[] = [];
  const rest: WebSearchResult[] = [];
  for (const r of unique) {
    const site = registrableDomain(hostOf(r.url));
    if (site && !seenSite.has(site)) {
      seenSite.add(site);
      firstPerSite.push(r);
    } else {
      rest.push(r);
    }
  }
  return [...firstPerSite, ...rest].slice(0, limit);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

async function readPage(
  url: string,
  skills: SkillRegistry,
  ctx: SkillContext,
  timeoutMs: number,
): Promise<string | undefined> {
  const read = await withTimeout(
    skills.invoke('research.open', { url }, { ...ctx, showResults: undefined }),
    timeoutMs,
  );
  if (!read || !read.ok) return undefined;
  const page = read.data as WebPage | undefined;
  return page?.text?.trim() ? page.text : undefined;
}

async function search(
  query: string,
  topic: 'general' | 'news',
  skills: SkillRegistry,
  ctx: SkillContext,
): Promise<{ ok: boolean; results: WebSearchResult[] }> {
  try {
    const r = await skills.invoke('research.search', { query, topic }, ctx);
    return { ok: r.ok, results: r.ok ? ((r.data as WebSearchResult[] | undefined) ?? []) : [] };
  } catch {
    return { ok: false, results: [] };
  }
}

export async function gatherEvidence(
  question: string,
  decision: RouteDecision,
  skills: SkillRegistry,
  ctx: SkillContext,
  options: ResearchOptions = {},
): Promise<ResearchResult> {
  const o = { ...DEFAULTS, read: true, now: () => new Date(), ...options };
  const now = o.now();

  ctx.activity?.note('Checking the web', decision.reason);

  const query = rewriteQuery(question, decision.category, now);
  let found = await search(query, decision.topic, skills, ctx);

  // A tidied query can miss what the person's own words would have hit.
  if (found.ok && !found.results.length && query !== question.trim()) {
    found = await search(question.trim(), decision.topic, skills, ctx);
  }
  if (!found.ok) return { status: 'unavailable' };
  if (!found.results.length) return { status: 'no-results' };

  const chosen = chooseSources(found.results, o.maxSources);
  const inputs: EvidenceInput[] = chosen.map((result) => ({ result }));

  if (o.read) {
    const toRead = inputs.slice(0, o.maxRead);
    const hosts = toRead.map((i) => hostOf(i.result.url)).filter(Boolean);
    const step = ctx.activity?.step('Reading sources', hosts.join(', '));
    const pages = await Promise.all(
      toRead.map((i) => readPage(i.result.url, skills, ctx, o.readTimeoutMs)),
    );
    pages.forEach((text, idx) => {
      if (text) toRead[idx]!.pageText = text;
    });
    const got = pages.filter(Boolean).length;
    step?.done(`${got} of ${toRead.length} read`);
  }

  const first = chosen[0]!;
  const packet = buildPacket({
    question,
    query,
    category: decision.category,
    provider: first.provider ?? 'unknown',
    providerLabel: providerLabelFor(first.provider),
    inputs,
    now,
  });

  const v = packet.verification;
  ctx.activity?.note(
    'Checked sources',
    `${v.independentSources} site${v.independentSources === 1 ? '' : 's'} · ${v.agreement}`,
  );
  return { status: 'ok', packet, results: found.results };
}

function providerLabelFor(id: string | undefined): string {
  switch (id) {
    case 'tavily':
      return 'Tavily';
    case 'duckduckgo':
      return 'DuckDuckGo';
    default:
      return id ?? 'web search';
  }
}
