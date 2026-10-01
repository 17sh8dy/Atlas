/**
 * "do that again" and "undo that" — through the real Engine and Executor.
 */

import { assert, test } from 'vitest';
import type { Skill } from '@atlas/core';
import { Engine, type EngineIO } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { SkillRegistry } from '../src/skills/registry';

function rig() {
  const state = { volume: 40, theme: 'light', calls: [] as string[], deleted: 0 };
  const skills = new SkillRegistry();
  const mk = (s: Partial<Skill> & Pick<Skill, 'id' | 'run'>): Skill => ({ label: s.id, icon: 'x', domain: 'x', description: 'does ' + s.id, risk: 'safe', params: {}, ...s }) as Skill;
  skills.registerMany([
    mk({
      id: 'system.volumeSet',
      params: { level: { type: 'number', required: false, description: '' } },
      async run(args) {
        const before = state.volume;
        state.volume = Number(args.level);
        state.calls.push(`volume ${state.volume}`);
        return { ok: true, message: `Volume ${state.volume}%`, undo: { skill: 'system.volumeSet', args: { level: before }, label: `volume back to ${before}%` } };
      },
    }),
    mk({
      id: 'system.theme',
      params: { mode: { type: 'string', required: true, description: '' } },
      async run(args) {
        const before = state.theme;
        state.theme = String(args.mode);
        state.calls.push(`theme ${state.theme}`);
        return { ok: true, message: 'ok', undo: { skill: 'system.theme', args: { mode: before }, label: 'back' } };
      },
    }),
    mk({
      id: 'files.delete',
      risk: 'confirm',
      params: { path: { type: 'string', required: true, description: '' } },
      async run() {
        state.deleted++;
        return { ok: true, message: 'deleted' };
      },
    }),
    mk({ id: 'time.now', async run() { return { ok: true, message: 'noon' }; } }),
  ]);
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(new WorkingMemory()));
  grammar.addMany(createExtraGrammar());
  const engine = new Engine({ skills, grammar });
  const said: string[] = [];
  const asked: string[] = [];
  let answer = true;
  const io: EngineIO = { say: (t) => void said.push(t), confirm: async (q, d) => { asked.push(`${q} ${d ?? ''}`); return answer; } };
  return { engine, state, said, asked, io, setAnswer: (a: boolean) => (answer = a) };
}

test('"undo that" puts a reversible setting back', async () => {
  const r = rig();
  await r.engine.ask('set the volume to 90', r.io);
  assert.equal(r.state.volume, 90);
  await r.engine.ask('undo that', r.io);
  assert.equal(r.state.volume, 40, 'back where it was');
  assert.deepEqual(r.state.calls, ['volume 90', 'volume 40']);
});

test('undo is one step deep: undoing twice does not undo the undo', async () => {
  const r = rig();
  await r.engine.ask('set the volume to 90', r.io);
  await r.engine.ask('undo that', r.io);
  await r.engine.ask('undo that', r.io);
  assert.equal(r.state.volume, 40);
  assert.equal(r.state.calls.length, 2, 'the second undo found nothing to do');
});

test('a later action replaces what can be undone', async () => {
  const r = rig();
  await r.engine.ask('set the volume to 90', r.io);
  await r.engine.ask('what time is it', r.io); // nothing to undo from this
  await r.engine.ask('undo that', r.io);
  assert.equal(r.state.volume, 90, 'the volume change is no longer "that"');
});

test('"do that again" repeats the last plan', async () => {
  const r = rig();
  await r.engine.ask('set the volume to 90', r.io);
  r.state.volume = 10; // changed by hand since
  await r.engine.ask('do that again', r.io);
  assert.equal(r.state.volume, 90);
  await r.engine.ask('again', r.io);
  assert.equal(r.state.calls.length, 3);
});

test('repeating something that asks, asks again — it does not borrow the first yes', async () => {
  const r = rig();
  await r.engine.ask('delete D:\\x.txt', r.io);
  await r.engine.ask('do that again', r.io);
  assert.equal(r.asked.length, 2);
  assert.equal(r.state.deleted, 2);
  r.setAnswer(false);
  await r.engine.ask('repeat that', r.io);
  assert.equal(r.asked.length, 3);
  assert.equal(r.state.deleted, 2, 'a no is a no');
});

test('with nothing to repeat, it says so and does nothing', async () => {
  const r = rig();
  const out = await r.engine.ask('do that again', r.io);
  assert.equal(out.ok, false);
  assert.match(r.said.join(' '), /nothing to repeat/);
});

test('repeating a repeat repeats the original, not the word "again"', async () => {
  const r = rig();
  await r.engine.ask('set the volume to 90', r.io);
  await r.engine.ask('again', r.io);
  await r.engine.ask('again', r.io);
  assert.deepEqual(r.state.calls, ['volume 90', 'volume 90', 'volume 90']);
});

test('an undo is offered for what a skill said it could put back', async () => {
  const r = rig();
  await r.engine.ask('switch to dark mode', r.io);
  assert.equal(r.state.theme, 'dark');
  await r.engine.ask('undo', r.io);
  assert.equal(r.state.theme, 'light');
});
