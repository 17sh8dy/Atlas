/**
 * The agent router, measured: it must (almost) never offer the agent for conversation or writing, and it
 * should catch most real multi-part jobs the rules do not fully cover. R_A calibrated the thresholds; R_B was
 * written after, so R_B is the honest figure. A request the rules fully and plausibly understand never reaches
 * the router in the engine, so such requests are counted as handled.
 */
import { expect, test } from 'vitest';
import { SkillRegistry } from '../src/skills/registry';
import { CapabilityIndex } from '../src/capabilities';
import { shouldRouteToAgent, trustPlan, chainClauses } from '../src/universal/router';
import { everySkill } from './helpers/every-skill';
import { grammar } from './coverage/measure';
import { understand } from './helpers/chain';
import { R_A, R_B, type Route } from './coverage/route-sets';

const all = everySkill();
const needs = [...new Set(all.flatMap((s) => s.needs ?? []))] as never[];
const reg = new SkillRegistry({ capabilities: () => needs });
reg.registerMany(all);
const index = new CapabilityIndex(reg);
const g = grammar();

function score(set: Route[]) {
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (const c of set) {
    const plan = understand(g, c.text).plan;
    const handled = plan !== null && trustPlan(plan, c.text, index).trust;
    const routed = !handled && shouldRouteToAgent(c.text, index).route;
    if (c.route) routed ? tp++ : fn++;
    else routed ? fp++ : tn++;
  }
  return { tp, fn, fp, tn };
}

test('R_A and R_B: no conversation or writing is offered to the agent', () => {
  expect(score(R_A).fp).toBe(0);
  expect(score(R_B).fp).toBe(0);
});

test('R_B: most real multi-part jobs the rules do not cover are caught (or handled by a trusted plan)', () => {
  const s = score(R_B);
  const jobs = s.tp + s.fn;
  // Jobs that a trusted rule plan handles count as handled, not as misses, so recall is over what was routed.
  expect(s.tp / jobs).toBeGreaterThanOrEqual(0.7);
});

test('chain clauses split only at real action boundaries', () => {
  expect(chainClauses('salt and pepper shakers')).toEqual(['salt and pepper shakers']);
  expect(chainClauses('find big files and then zip them')).toEqual(['find big files', 'zip them']);
  expect(chainClauses('find it and open its folder')).toHaveLength(2);
  expect(chainClauses('search youtube for cats and dogs')).toHaveLength(1);
});

test('plausibility guard: a catch-all rule that took non-names is not believed', () => {
  const t = (skill: string, args: Record<string, string>, text: string) => trustPlan({ steps: [{ skill, args }] }, text, index).trust;
  expect(t('files.list', { path: 'the running programs' }, 'list the running programs')).toBe(false);
  expect(t('files.find', { query: 'the largest files on my D drive' }, 'find the largest files on my D drive')).toBe(false);
  expect(t('app.open', { name: 'the volume down to 10' }, 'bring the volume down to 10')).toBe(false);
  expect(t('files.find', { query: 'resume' }, 'find my resume')).toBe(true);
  expect(t('app.open', { name: 'steam' }, 'open steam')).toBe(true);
});
