/**
 * The collapsed action summary — "Ran 3 actions ▸", "Stopped after 1 of 4
 * actions ▸" — and the one property that matters about it: **every number in
 * it is a real execution result.**
 *
 * That property is easy to lose. A disclosure like this is exactly the kind of
 * thing that gets wired to a spinner, a step index the UI increments as it
 * goes, or a plan's length decided before anything ran — any of which would
 * keep reading plausibly while saying something untrue, which is worse than
 * saying nothing. It matters most after an emergency stop, where "Stopped
 * after 1 of 4" is the answer to "what had Atlas already done to my machine?"
 *
 * So these tests never hand-write an outcome. They run a real `Executor` over
 * real skills, take the `PlanOutcome` it returns, and push it through the same
 * two functions the transcript uses. A step reports `done` here only because a
 * skill actually ran and returned `ok`.
 */

import { test, assert } from 'vitest';
import type { Plan, Skill, SkillContext } from '@atlas/core';
import { HaltController } from '@atlas/core';
import { Executor, SkillRegistry } from '@atlas/engine';
import { stepRowsFrom } from '../src/atlas/useAtlas';
import { summarizeSteps } from '../src/components/Transcript';

function skill(id: string, run: Skill['run'], risk: Skill['risk'] = 'safe'): Skill {
  return { id, label: id, domain: id.split('.')[0]!, description: id, risk, params: {}, run };
}

function plan(...ids: string[]): Plan {
  return {
    source: 'grammar',
    intent: 'test',
    confidence: 1,
    steps: ids.map((skill) => ({ skill, args: {} })),
  };
}

function context(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    say: () => {},
    confirm: async () => true,
    platform: {} as SkillContext['platform'],
    ...overrides,
  } as SkillContext;
}

/** Run a plan for real, then render it exactly as the transcript would. */
async function summaryOf(
  p: Plan,
  skills: Skill[],
  ctx: SkillContext = context(),
  options = {},
): Promise<{ summary: string; rows: ReturnType<typeof stepRowsFrom> }> {
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany(skills);
  const outcome = await new Executor(registry).run(p, ctx, options);
  const rows = stepRowsFrom(outcome, (id) => registry.get(id)?.label ?? id);
  return { summary: summarizeSteps(rows), rows };
}

test('three steps that really ran read as three actions', async () => {
  const ran: string[] = [];
  const { summary, rows } = await summaryOf(plan('a.one', 'a.two', 'a.three'), [
    skill('a.one', async () => (ran.push('one'), { ok: true })),
    skill('a.two', async () => (ran.push('two'), { ok: true })),
    skill('a.three', async () => (ran.push('three'), { ok: true })),
  ]);

  assert.deepEqual(ran, ['one', 'two', 'three'], 'the skills actually ran');
  assert.equal(summary, 'Ran 3 actions');
  assert.deepEqual(
    rows.map((r) => r.state),
    ['done', 'done', 'done'],
  );
});

test('a step that failed is not counted as one that ran', async () => {
  const { summary, rows } = await summaryOf(plan('a.one', 'a.two', 'a.three'), [
    skill('a.one', async () => ({ ok: true })),
    skill('a.two', async () => ({ ok: false, error: 'No such file.' })),
    skill('a.three', async () => ({ ok: true })),
  ]);

  // Out of three, not out of two: the executor accounts for the step it never
  // reached, so the summary cannot flatter a plan that barely started.
  assert.equal(summary, '1 of 3 actions completed');
  assert.deepEqual(
    rows.map((r) => r.state),
    ['done', 'failed', 'skipped'],
  );
  assert.equal(rows[1]!.detail, 'No such file.', 'the reason shown is the skill’s own');
});

test('the count after a halt is what had really been done by then', async () => {
  const halt = new HaltController();
  const ran: string[] = [];
  const reached = { two: false };

  const { summary, rows } = await summaryOf(
    plan('a.one', 'a.two', 'a.three', 'a.four'),
    [
      skill('a.one', async () => (ran.push('one'), { ok: true, message: 'opened it' })),
      skill('a.two', async () => {
        reached.two = true;
        ran.push('two');
        return { ok: true };
      }),
      skill('a.three', async () => (ran.push('three'), { ok: true })),
      skill('a.four', async () => (ran.push('four'), { ok: true })),
    ],
    context({
      // The stop lands *between* the first step and the second — the place
      // the latch actually sits, native side included. The first step's own
      // reply reaching the transcript is the moment it has finished.
      say: (text: string) => {
        if (text === 'opened it') halt.abort();
      },
    }),
    { signal: halt.signal },
  );

  assert.deepEqual(ran, ['one'], 'nothing started after the stop');
  assert.isFalse(reached.two);
  assert.equal(summary, 'Stopped after 1 of 4 actions');
  assert.deepEqual(
    rows.map((r) => r.state),
    ['done', 'halted', 'halted', 'halted'],
  );
});

test('a declined step ends the plan and says so, without claiming the rest', async () => {
  const ran: string[] = [];
  const { summary, rows } = await summaryOf(
    plan('a.one', 'a.risky', 'a.three'),
    [
      skill('a.one', async () => (ran.push('one'), { ok: true })),
      skill('a.risky', async () => (ran.push('risky'), { ok: true }), 'confirm'),
      skill('a.three', async () => (ran.push('three'), { ok: true })),
    ],
    context({ confirm: async () => false }),
  );

  assert.deepEqual(ran, ['one'], 'a declined step does not run, and nor does what follows it');
  assert.equal(summary, '1 of 3 actions completed');
  assert.deepEqual(
    rows.map((r) => r.state),
    ['done', 'declined', 'skipped'],
  );
});

test('an empty run produces no numbers to be wrong about', () => {
  assert.equal(summarizeSteps([]), 'Ran 0 actions');
});
