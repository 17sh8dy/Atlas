/**
 * "When I plug in my headphones, …" — a watch on a device being connected.
 */

import { assert, test } from 'vitest';
import type { Platform } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { deviceMatches, describeCondition, probeCondition, reliableAfterGap } from '../src/watch/conditions';

function grammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}

test('it is understood as a watch', () => {
  const p = grammar().parse('when I plug in my headphones, tell me');
  assert.equal(p?.steps[0]?.skill, 'watch.create');
  assert.equal(p?.steps[0]?.args.when, 'I plug in my headphones');
  assert.equal(grammar().parse('let me know when my headset is connected')?.steps[0]?.skill, 'watch.create');
});

test('a device is found by what people call it', () => {
  assert.equal(deviceMatches('headphones', ['Microphone (Yeti)', 'Headphones (Realtek Audio)']), 'Headphones (Realtek Audio)');
  assert.equal(deviceMatches('my headset', [null, 'Headset Earphone (Logitech)']), 'Headset Earphone (Logitech)');
  assert.equal(deviceMatches('mic', ['Microphone (Shure MV7)', 'Speakers']), 'Microphone (Shure MV7)');
  assert.equal(deviceMatches('the dac', ['Speakers (Realtek)', 'Headphones']), null);
  assert.equal(deviceMatches('', ['Speakers']), null);
});

test('the condition is met when it shows up, and not before', async () => {
  const cond = { kind: 'device-appears' as const, match: 'headphones' };
  let out = 'Speakers (Realtek Audio)';
  const platform = { audioDevices: async () => ({ input: 'Microphone (Yeti)', output: out }) } as unknown as Platform;
  const before = await probeCondition(cond, platform, { startedAt: 0 }, 0);
  assert.equal(before.met, false);
  assert.match(before.detail, /isn’t connected yet/);
  out = 'Headphones (Realtek Audio)';
  const after = await probeCondition(cond, platform, { startedAt: 0 }, 0);
  assert.equal(after.met, true);
  assert.match(after.detail, /connected \(Headphones \(Realtek Audio\)\)/);
});

test('it reads back in words and is a state, so a late check is still true', () => {
  const cond = { kind: 'device-appears' as const, match: 'headphones', label: 'your headphones' };
  assert.equal(describeCondition(cond), 'your headphones is connected');
  assert.equal(reliableAfterGap(cond, 99 * 3_600_000), true);
});

test('a platform that cannot see devices says so instead of pretending', async () => {
  const r = await probeCondition({ kind: 'device-appears', match: 'headphones' }, {} as Platform, { startedAt: 0 }, 0);
  assert.equal(r.met, false);
  assert.match(r.detail, /can’t see audio devices/);
});
