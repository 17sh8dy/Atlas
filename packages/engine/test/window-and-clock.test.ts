/**
 * The bare window verbs ("maximize spotify"), show desktop, always-on-top, and
 * "what day is it in tokyo".
 */

import { assert, test } from 'vitest';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';

function grammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}
const plan = (text: string) =>
  grammar()
    .parse(text)
    ?.steps.map((s) => [s.skill, s.args]);

test('a bare verb and an app name reach the window skills', () => {
  assert.deepEqual(plan('maximize spotify'), [['window.maximize', { name: 'spotify' }]]);
  assert.deepEqual(plan('minimize discord'), [['window.minimize', { name: 'discord' }]]);
  assert.deepEqual(plan('restore notepad'), [['window.restore', { name: 'notepad' }]]);
  assert.deepEqual(plan('close notepad'), [['window.close', { name: 'notepad' }]]);
  assert.deepEqual(plan('bring notepad to the front'), [['window.focus', { name: 'notepad' }]]);
});

test('the same words still mean what they always did when no window is meant', () => {
  assert.equal(grammar().parse('close')?.steps[0]?.skill, 'atlas.hide');
  assert.equal(grammar().parse('close atlas')?.steps[0]?.skill, 'atlas.hide');
  assert.equal(grammar().parse('close this')?.steps[0]?.skill, 'atlas.hide');
  assert.equal(grammar().parse('restore my backup'), null);
  assert.equal(grammar().parse('focus mode'), null);
  // and the old spelling is unchanged
  assert.deepEqual(plan('maximize the notepad window'), [['window.maximize', { name: 'notepad' }]]);
});

test('closing something asks first, like every other way of closing it', () => {
  // The skill is the same one; its own risk applies. (See window-skills.ts.)
  assert.deepEqual(plan('close chrome'), [['window.close', { name: 'chrome' }]]);
});

test('show desktop and minimize everything are one key', () => {
  assert.deepEqual(plan('show desktop'), [['input.hotkey', { combo: 'win+d' }]]);
  assert.deepEqual(plan('minimize everything'), [['input.hotkey', { combo: 'win+d' }]]);
  assert.deepEqual(plan('minimize all windows'), [['input.hotkey', { combo: 'win+d' }]]);
});

test('always on top', () => {
  assert.deepEqual(plan('keep notepad on top'), [['window.pin', { name: 'notepad' }]]);
  assert.deepEqual(plan('make spotify always on top'), [['window.pin', { name: 'spotify' }]]);
  assert.deepEqual(plan('unpin notepad'), [['window.unpin', { name: 'notepad' }]]);
});

// ---- the clock -------------------------------------------------------------------------

test('"what day is it in tokyo" asks for the date, and no longer answers for the local city', () => {
  assert.deepEqual(plan('what time is it in tokyo'), [['time.inZone', { place: 'tokyo' }]]);
  assert.deepEqual(plan('what day is it in tokyo'), [['time.inZone', { place: 'tokyo', date: true }]]);
  assert.deepEqual(plan("what's the date in sydney"), [['time.inZone', { place: 'sydney', date: true }]]);
  assert.deepEqual(plan('time in london'), [['time.inZone', { place: 'london' }]]);
  // the local clock is unchanged
  assert.equal(grammar().parse('what time is it')?.steps[0]?.skill, 'time.now');
  assert.equal(grammar().parse("what's the date")?.steps[0]?.skill, 'time.now');
});
