/**
 * The activity stream — what the expandable panel is built from.
 *
 * Two things are worth pinning here, and they are the two that would rot
 * silently. First that the events describe **real execution**: a step reports
 * `running` only once every gate in front of it has passed, and its end state
 * is the result the skill actually returned. Second, and more important, that
 * the channel carries **observable actions only** — there is no field a
 * reasoning trace could arrive in, and this test is where that stays true.
 */

import { test, assert } from 'vitest';
import type { Plan, Skill, SkillContext } from '@atlas/core';
import { HaltController } from '@atlas/core';
import { Executor } from '../src/planner/executor';
import { SkillRegistry } from '../src/skills/registry';
import type { ActivityEvent } from '../src/planner/executor';

function skill(id: string, run: Skill['run'], risk: Skill['risk'] = 'safe'): Skill {
  return { id, label: id, domain: id.split('.')[0]!, description: id, risk, params: {}, run };
}

function plan(...ids: string[]): Plan {
  return {
    source: 'grammar',
    intent: 'test',
    confidence: 1,
    steps: ids.map((s) => ({ skill: s, args: {} })),
  };
}

function context(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    say: () => {},
    confirm: async () => true,
    ...overrides,
  } as SkillContext;
}

async function runWith(
  p: Plan,
  skills: Skill[],
  ctx: SkillContext = context(),
  options: Record<string, unknown> = {},
) {
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany(skills);
  const events: ActivityEvent[] = [];
  const outcome = await new Executor(registry).run(p, ctx, {
    ...options,
    onActivity: (e) => events.push(e),
  });
  return { events, outcome };
}

test('each step reports starting and finishing, in plan order', async () => {
  const { events } = await runWith(plan('a.one', 'a.two'), [
    skill('a.one', async () => ({ ok: true, message: 'did one' })),
    skill('a.two', async () => ({ ok: true, message: 'did two' })),
  ]);

  const top = events.filter((e) => !e.childId);
  assert.deepEqual(
    top.map((e) => [e.index, e.skill, e.state]),
    [
      [0, 'a.one', 'running'],
      [0, 'a.one', 'done'],
      [1, 'a.two', 'running'],
      [1, 'a.two', 'done'],
    ],
  );
  // `total` is on the first event, so a panel can say "1 of 2" immediately
  // rather than counting up as it goes and jumping around.
  assert.isTrue(top.every((e) => e.total === 2));
});

test('a step reports the failure the skill actually returned', async () => {
  const { events } = await runWith(plan('a.one'), [
    skill('a.one', async () => ({ ok: false, error: 'No such file.' })),
  ]);
  const last = events.at(-1)!;
  assert.equal(last.state, 'failed');
  assert.equal(last.detail, 'No such file.');
});

test('a declined step is reported as skipped, not as running forever', async () => {
  const { events } = await runWith(
    plan('a.risky'),
    [skill('a.risky', async () => ({ ok: true }), 'confirm')],
    context({ confirm: async () => false }),
  );
  assert.deepEqual(
    events.map((e) => e.state),
    ['skipped'],
  );
});

test('nothing is announced as running until every gate in front of it passed', async () => {
  // The bug this guards: reporting at the top of the loop, so a step the user
  // is still being *asked* about shows in the panel as already under way.
  const asked: string[] = [];
  // Its own collector, because the assertion has to run *inside* the confirm
  // — by the time `runWith` returns, the step has legitimately started.
  const seen: ActivityEvent[] = [];
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany([skill('a.risky', async () => ({ ok: true }), 'confirm')]);
  await new Executor(registry).run(
    plan('a.risky'),
    context({
      confirm: async (q: string) => {
        asked.push(q);
        // At the moment the question is put, nothing may have been announced.
        assert.deepEqual(seen, [], 'a step was announced before it was approved');
        return true;
      },
    }),
    { onActivity: (e) => seen.push(e) },
  );
  const events = seen;
  assert.lengthOf(asked, 1);
  assert.deepEqual(
    events.map((e) => e.state),
    ['running', 'done'],
  );
});

test('a skill can report its own observable sub-steps', async () => {
  const { events } = await runWith(plan('web.search'), [
    skill('web.search', async (_args, ctx) => {
      const searching = ctx.activity?.step('Searching the web', 'tide times');
      searching?.done('7 results');
      ctx.activity?.note('Sources', 'bbc.co.uk, metoffice.gov.uk');
      return { ok: true, message: '' };
    }),
  ]);

  const children = events.filter((e) => e.childId);
  assert.deepEqual(
    children.map((e) => [e.label, e.detail, e.state]),
    [
      ['Searching the web', 'tide times', 'running'],
      ['Searching the web', '7 results', 'done'],
      ['Sources', 'bbc.co.uk, metoffice.gov.uk', 'done'],
    ],
  );
  // A sub-step is attributed to the step that reported it, so a surface can
  // nest without the skill knowing nesting exists.
  assert.isTrue(children.every((e) => e.index === 0 && e.skill === 'web.search'));
});

test('a halt stops the stream rather than reporting steps that never ran', async () => {
  const halt = new HaltController();
  const ran: string[] = [];
  const { events } = await runWith(
    plan('a.one', 'a.two', 'a.three'),
    [
      skill('a.one', async () => (ran.push('one'), { ok: true, message: 'done one' })),
      skill('a.two', async () => (ran.push('two'), { ok: true })),
      skill('a.three', async () => (ran.push('three'), { ok: true })),
    ],
    context({ say: (t: string) => t === 'done one' && halt.abort() }),
    { signal: halt.signal },
  );

  assert.deepEqual(ran, ['one']);
  // Two and three are absent entirely: the panel shows what happened, and
  // inventing a row for a step that never started would be the opposite.
  assert.deepEqual(
    events.filter((e) => !e.childId).map((e) => [e.index, e.state]),
    [
      [0, 'running'],
      [0, 'done'],
    ],
  );
});

/**
 * The privacy rule, enforced rather than trusted. An activity event is a
 * record of something Atlas *did*; if a field for deliberation is ever added,
 * this is where the argument has to happen.
 */
test('an activity event carries no channel for reasoning', async () => {
  const { events } = await runWith(plan('a.one'), [
    skill('a.one', async (_args, ctx) => {
      ctx.activity?.note('Reading', 'C:\\Users\\me\\notes.txt');
      return { ok: true };
    }),
  ]);

  const allowed = new Set(['index', 'total', 'skill', 'label', 'detail', 'state', 'at', 'childId']);
  for (const event of events) {
    for (const key of Object.keys(event)) {
      assert.isTrue(
        allowed.has(key),
        `activity events carry observable actions only — "${key}" is not one of them`,
      );
    }
  }
});
