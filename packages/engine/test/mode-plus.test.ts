/**
 * Do It + : far fewer questions, never none.
 *
 * Real `Executor` and `SkillRegistry`, fake skills. The point is the behaviour a person sees:
 * which actions run silently and which still stop, in Do It + and in the modes around it.
 */

import { assert, test } from 'vitest';
import type { ExecutionMode, Plan, Skill, SkillContext } from '@atlas/core';
import { EXECUTION_MODES, EXECUTION_MODE_META } from '@atlas/core';
import { Executor } from '../src/planner/executor';
import { SkillRegistry } from '../src/skills/registry';
import { ALWAYS_ASK_IN_DO_IT_PLUS, asksEvenInDoItPlus } from '../src/safety/dangerous';

function confirmSkill(id: string, log: string[], extra: Partial<Skill> = {}): Skill {
  return {
    id,
    label: id,
    domain: 'files',
    description: `does ${id}`,
    risk: 'confirm',
    params: {},
    run: async () => {
      log.push(id);
      return { ok: true, message: 'done' };
    },
    ...extra,
  };
}

async function run(ids: string[], mode: ExecutionMode, extra: Record<string, Partial<Skill>> = {}) {
  const ran: string[] = [];
  const cards: string[] = [];
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany(ids.map((id) => confirmSkill(id, ran, extra[id])));
  const ctx: SkillContext = {
    say: () => {},
    showResults: () => {},
    confirm: async (question) => {
      cards.push(question);
      return true;
    },
  };
  const plan: Plan = {
    source: 'grammar',
    intent: 'test',
    confidence: 1,
    steps: ids.map((skill) => ({ skill, args: {} })),
  };
  await new Executor(registry).run(plan, ctx, { mode });
  return { ran, cards };
}

test('Do It + is a real mode with a label and a description that names what it still asks about', () => {
  assert.include(EXECUTION_MODES, 'doItPlus');
  assert.equal(EXECUTION_MODE_META.doItPlus.label, 'Do It +');
  assert.match(EXECUTION_MODE_META.doItPlus.description, /dangerous/i);
  assert.match(EXECUTION_MODE_META.doItPlus.description, /Recycle Bin/);
});

test('Do It + runs routine consequential work without asking', () =>
  run(['code.write', 'build.run', 'test.run', 'script.python', 'git.commit', 'files.create'], 'doItPlus').then(
    ({ ran, cards }) => {
      assert.equal(ran.length, 6);
      assert.deepEqual(cards, []);
    },
  ));

test('the same plan asks for every step in Confirm Actions, and Do It? asks for all but allowed-folder file work', async () => {
  const ids = ['code.write', 'build.run'];
  assert.equal((await run(ids, 'confirmActions')).cards.length, 2);
  assert.equal((await run(ids, 'doIt')).cards.length, 2);
});

test('Do It + still asks before anything dangerous, and the rest of the plan is unaffected', async () => {
  const { ran, cards } = await run(
    ['code.write', 'files.delete', 'system.emptyRecycleBin', 'git.push', 'apps.uninstall', 'build.run'],
    'doItPlus',
  );
  assert.equal(cards.length, 4, 'delete, empty, push and uninstall each ask');
  assert.deepEqual(ran, ['code.write', 'files.delete', 'system.emptyRecycleBin', 'git.push', 'apps.uninstall', 'build.run']);
});

test('declining a dangerous step in Do It + stops the plan, as in every mode', async () => {
  const ran: string[] = [];
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany([confirmSkill('files.delete', ran), confirmSkill('code.write', ran)]);
  const ctx: SkillContext = { say: () => {}, showResults: () => {}, confirm: async () => false };
  const plan: Plan = {
    source: 'grammar',
    intent: 'test',
    confidence: 1,
    steps: [
      { skill: 'files.delete', args: {} },
      { skill: 'code.write', args: {} },
    ],
  };
  await new Executor(registry).run(plan, ctx, { mode: 'doItPlus' });
  assert.deepEqual(ran, []);
});

test('a skill that merely sounds destructive asks too, so a new one fails safe', () => {
  for (const id of ['photos.deleteAlbum', 'disk.format', 'app.forceKill', 'cache.purge', 'x.uninstallThing']) {
    assert.isTrue(asksEvenInDoItPlus({ id }), id);
  }
  for (const id of ['code.write', 'build.run', 'test.run', 'script.node', 'files.create', 'git.commit']) {
    assert.isFalse(asksEvenInDoItPlus({ id }), id);
  }
});

test('a skill that refuses on its own terms is still refused in Do It +', async () => {
  const ran: string[] = [];
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany([
    confirmSkill('code.write', ran, { guard: () => 'That path is off limits.' }),
  ]);
  const said: string[] = [];
  const ctx: SkillContext = { say: (m) => said.push(m), showResults: () => {}, confirm: async () => true };
  const plan: Plan = { source: 'grammar', intent: 'test', confidence: 1, steps: [{ skill: 'code.write', args: {} }] };
  await new Executor(registry).run(plan, ctx, { mode: 'doItPlus' });
  assert.deepEqual(ran, []);
});

test('the always-ask list names real skills only', () => {
  // A typo here would silently leave a dangerous skill unprotected by name (the pattern is a
  // second net, not a substitute), so every entry must look like a skill id.
  for (const id of ALWAYS_ASK_IN_DO_IT_PLUS) assert.match(id, /^[a-z]+\.[a-zA-Z]+$/);
});
