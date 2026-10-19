import { test } from 'vitest';
import { SkillRegistry } from '../../src/skills/registry';
import { CapabilityIndex } from '../../src/capabilities';
import { shouldRouteToAgent, chainClauses, trustPlan } from '../../src/universal/router';
import { everySkill } from '../helpers/every-skill';
import { R_A, R_B } from './route-sets';
import { grammar } from './measure';
import { understand } from '../helpers/chain';

test('route probe', () => {
  const all = everySkill();
  const needs = [...new Set(all.flatMap((s) => s.needs ?? []))] as never[];
  const reg = new SkillRegistry({ capabilities: () => needs });
  reg.registerMany(all);
  const idx = new CapabilityIndex(reg);
  const g = grammar();
  for (const [name, set] of [['A', R_A], ['B', R_B]] as const) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    const L: string[] = [];
    for (const c of set) {
      const pl = understand(g, c.text).plan; const claimed = pl !== null && trustPlan(pl, c.text, idx).trust;
      const d = shouldRouteToAgent(c.text, idx);
      // A request the grammar already claims never reaches the router in the engine.
      const routed = !claimed && d.route;
      if (c.route && routed) tp++;
      else if (c.route && !routed) { fn++; L.push(`FN ${c.text} :: ${claimed ? 'grammar claimed ' + (pl ? pl.steps.map((x) => x.skill).join('+') : '?') + ' for ' + chainClauses(c.text).length + ' clauses' : d.reason}`); }
      else if (!c.route && routed) { fp++; L.push(`FP ${c.text} :: ${d.reason}`); }
      else tn++;
    }
    console.log(`ROUTE ${name} tp=${tp} fn=${fn} fp=${fp} tn=${tn}\n${L.join('\n')}`);
  }
});
