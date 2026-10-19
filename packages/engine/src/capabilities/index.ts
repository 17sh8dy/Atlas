/**
 * The capability index: finding what can do a thing, without showing a model everything.
 *
 * Built over the existing `SkillRegistry` (nothing is copied or re-registered), it answers three
 * questions the planner and the universal agent keep asking:
 *
 *   · `search(query)` — which capabilities are worth considering for this request? BM25 over each skill's
 *     own text (the router that already ships), with the query first widened by the synonym table, so
 *     "fire up" finds "open" and "directory" finds "folder".
 *   · `disclose(query)` — the same, shaped for a prompt: the best few families, then the best few
 *     capabilities, bounded. This is how the catalog stays small as the registry grows: a prompt never
 *     carries more than `limit` tools however many are registered (`index.test` measures it at 10,000).
 *   · `describe(id)` / `descriptors()` — the readable record for each capability (`describe.ts`).
 *
 * It decides nothing. It narrows a list; the grammar, the gateway, the executor and the person still
 * decide, and a query that matches nothing returns nothing rather than a guess.
 */

import type { Skill } from '@atlas/core';
import { scoreSkills, tokenize } from '../skills/router';
import type { SkillRegistry } from '../skills/registry';
import { describeSkill, type CapabilityDescriptor } from './describe';
import { FAMILIES, familyInfo, familyOf, type Family, type FamilyId } from './families';
import { SYNONYM_GROUPS } from './vocabulary';

/** stemmed word → every OTHER stemmed word it can stand for. Built once. */
const WIDEN: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    const stems = group.map((w) => tokenize(w)[0]).filter((s): s is string => !!s);
    for (const s of stems) {
      const others = stems.filter((o) => o !== s);
      map.set(s, [...new Set([...(map.get(s) ?? []), ...others])]);
    }
  }
  return map;
})();

/** The other words for each word in the query (not the words themselves), capped. */
export function synonymsOf(query: string): string {
  const words = tokenize(query);
  const extra: string[] = [];
  for (const w of words) for (const o of WIDEN.get(w) ?? []) if (!words.includes(o)) extra.push(o);
  // Capped so a long sentence of common verbs cannot swamp what the person actually said.
  return [...new Set(extra)].slice(0, 40).join(' ');
}

/** The query followed by its synonyms, for callers that want one string. */
export function widenQuery(query: string): string {
  const extra = synonymsOf(query);
  return extra ? `${query} ${extra}` : query;
}

/**
 * How much a synonym counts next to a word the person actually said. Less than half: "diff" is how
 * "compare" is sometimes said, but a skill that contains "compare" must still beat one that merely
 * contains "diff" (a time-zone difference is not a file comparison).
 */
const SYNONYM_WEIGHT = 0.35;

export interface SearchOptions {
  limit?: number;
  family?: FamilyId;
  /** Hide capabilities this build lacks (default true: they could not run anyway). */
  availableOnly?: boolean;
}

export interface Hit {
  skill: Skill;
  score: number;
  family: FamilyId;
}

export interface Disclosure {
  families: Array<Family & { score: number }>;
  hits: Hit[];
  /** Characters of catalog this disclosure would add to a prompt. */
  catalogChars: number;
}

export class CapabilityIndex {
  constructor(private readonly registry: SkillRegistry) {}

  private pool(availableOnly: boolean): Skill[] {
    return availableOnly ? this.registry.available() : this.registry.all();
  }

  descriptors(options: { availableOnly?: boolean } = {}): CapabilityDescriptor[] {
    return this.pool(options.availableOnly ?? false).map((s) => describeSkill(s, this.registry));
  }

  describe(id: string): CapabilityDescriptor | null {
    const s = this.registry.get(id);
    return s ? describeSkill(s, this.registry) : null;
  }

  families(): Array<Family & { count: number }> {
    const counts = new Map<FamilyId, number>();
    for (const s of this.registry.available()) counts.set(familyOf(s), (counts.get(familyOf(s)) ?? 0) + 1);
    return FAMILIES.filter((f) => counts.has(f.id)).map((f) => ({ ...f, count: counts.get(f.id)! }));
  }

  search(query: string, options: SearchOptions = {}): Hit[] {
    const pool = this.pool(options.availableOnly ?? true).filter((s) => !options.family || familyOf(s) === options.family);
    if (!query.trim() || pool.length === 0) return [];
    const said = scoreSkills(pool, query);
    const extra = synonymsOf(query);
    const alt = extra ? scoreSkills(pool, extra) : null;
    const scores = said.map((s, i) => s + (alt ? alt[i]! * SYNONYM_WEIGHT : 0));
    const hits = pool
      .map((skill, i) => ({ skill, score: scores[i]!, family: familyOf(skill) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score);
    return options.limit ? hits.slice(0, options.limit) : hits;
  }

  /**
   * Progressive disclosure: the best families for the request, then the best capabilities, never more
   * than `limit`. Within a family the ranking is the global one, so a strong match is never lost to a
   * family boundary.
   */
  disclose(query: string, options: { limit?: number; families?: number } = {}): Disclosure {
    const limit = options.limit ?? 16;
    const all = this.search(query, { limit: Math.max(limit * 4, 60) });
    const byFamily = new Map<FamilyId, number>();
    for (const h of all) {
      // A family's score is its three best capabilities: one strong hit beats five weak ones.
      const seen = all.filter((x) => x.family === h.family).slice(0, 3).reduce((n, x) => n + x.score, 0);
      byFamily.set(h.family, seen);
    }
    const ranked = [...byFamily.entries()].sort((a, b) => b[1] - a[1]).slice(0, options.families ?? 4);
    const keep = new Set(ranked.map(([id]) => id));
    const hits = all.filter((h) => keep.has(h.family)).slice(0, limit);
    const catalogChars = hits.reduce((n, h) => n + h.skill.id.length + h.skill.description.length + 40, 0);
    return {
      families: ranked.map(([id, score]) => ({ ...familyInfo(id), score })),
      hits,
      catalogChars,
    };
  }
}

export { describeSkill, type CapabilityDescriptor } from './describe';
export { FAMILIES, familyOf, familyInfo, type Family, type FamilyId } from './families';
export { SYNONYM_GROUPS, FILLER_PREFIXES, FILLER_SUFFIXES, PHRASAL_VERBS } from './vocabulary';
