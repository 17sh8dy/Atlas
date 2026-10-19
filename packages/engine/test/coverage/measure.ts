/**
 * Runs the corpus through the same chain the engine uses (no model) and tallies, per area and wrapper,
 * what was understood correctly, understood as something else, or not understood (would go to a model).
 */
import { Grammar } from '../../src/planner/grammar';
import { createCoreGrammar } from '../../src/planner/core-grammar';
import { createExtraGrammar } from '../../src/planner/extra-grammar';
import { WorkingMemory } from '../../src/working-memory';
import { understand } from '../helpers/chain';
import { expand, type Case } from './corpus';

export type Verdict = 'ok' | 'wrong' | 'miss';

export interface Result extends Case {
  verdict: Verdict;
  got: string | null;
  via: string;
}

export function grammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}

export function measure(withParaphrase = true): Result[] {
  const g = grammar();
  return expand().map((c) => {
    const u = understand(g, c.text, withParaphrase);
    const got = u.plan?.steps[0]?.skill ?? null;
    const verdict: Verdict = got === null ? 'miss' : c.skill.split('|').includes(got) ? 'ok' : 'wrong';
    return { ...c, verdict, got, via: u.via };
  });
}

export interface Tally {
  total: number;
  ok: number;
  wrong: number;
  miss: number;
}

export function tally(results: readonly Result[], key: (r: Result) => string): Record<string, Tally> {
  const out: Record<string, Tally> = {};
  for (const r of results) {
    const t = (out[key(r)] ??= { total: 0, ok: 0, wrong: 0, miss: 0 });
    t.total += 1;
    t[r.verdict] += 1;
  }
  return out;
}
