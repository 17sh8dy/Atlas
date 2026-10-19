import { test } from 'vitest';
import { grammar } from './measure';
import { understand } from '../helpers/chain';
import { HELD_OUT_D } from './heldout-d';

test('C', () => {
  const g = grammar();
  let ok = 0, wrong = 0, miss = 0;
  const L: string[] = [];
  for (const c of HELD_OUT_D) {
    const got = understand(g, c.text).plan?.steps[0]?.skill ?? null;
    if (c.skill === 'none') {
      if (got === null) ok++;
      else { wrong++; L.push(`CLAIMED ${c.text} => ${got}`); }
      continue;
    }
    if (got === null) { miss++; L.push(`MISS ${c.text} (${c.skill})`); }
    else if (c.skill.split('|').includes(got)) ok++;
    else { wrong++; L.push(`WRONG ${c.text} => ${got} (${c.skill})`); }
  }
  console.log(`SET D ok=${ok} wrong=${wrong} miss=${miss} total=${HELD_OUT_D.length}\n${L.join('\n')}`);
});
