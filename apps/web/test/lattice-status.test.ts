/**
 * What the lattice shows, checked against real `ActivityRun` shapes — most
 * hand-built (this is a pure function over a plain data shape, the same way
 * `summarizeRun`/`elapsedLabel` in `@atlas/core` are tested), and the two that
 * matter most driven by a real `Executor` run, in `action-summary.test.ts`'s
 * own style: never hand-write an outcome when a real one is one call away.
 */

import { describe, test, assert } from 'vitest';
import type { ActivityRun, ActivityStep } from '@atlas/core';
import { HaltController } from '@atlas/core';
import type { Plan, Skill, SkillContext } from '@atlas/core';
import { Executor, SkillRegistry, type ActivityEvent } from '@atlas/engine';
import { latticeStatusFor } from '../src/components/lattice-status';

function step(over: Partial<ActivityStep>): ActivityStep {
  return { id: 's', label: 'Doing a thing', state: 'running', startedAt: 0, ...over };
}

function run(over: Partial<ActivityRun>): ActivityRun {
  return { id: 'r1', request: 'do a thing', startedAt: 0, steps: [], state: 'running', ...over };
}

describe('latticeStatusFor — the gap before any step exists', () => {
  test('no run at all reads as Thinking', () => {
    assert.deepEqual(latticeStatusFor(null), { phase: 'active', verb: 'Thinking', label: undefined });
    assert.deepEqual(latticeStatusFor(undefined), {
      phase: 'active',
      verb: 'Thinking',
      label: undefined,
    });
  });

  test('a run that exists but has no steps yet is still Thinking, not Planning', () => {
    // There is no event between "asked" and "the first step ran" that says
    // what the engine is doing in between — see the module doc for why this
    // stays the simpler label rather than a phase the data can't back up.
    assert.deepEqual(latticeStatusFor(run({ steps: [] })), {
      phase: 'active',
      verb: 'Thinking',
      label: undefined,
    });
  });
});

describe('latticeStatusFor — a step is running', () => {
  test('an ordinary skill reads as Working, with its own real label', () => {
    const r = run({ steps: [step({ label: 'Searching the web', skill: 'web.search' })] });
    assert.deepEqual(latticeStatusFor(r), { phase: 'active', verb: 'Working', label: 'Searching the web' });
  });

  test('test.run reads as Testing — its own catalogued domain, not a guess', () => {
    const r = run({ steps: [step({ label: 'Running the test suite', skill: 'test.run' })] });
    assert.equal(latticeStatusFor(r).verb, 'Testing');
  });

  test('build.run also reads as Testing — Brandon’s own word, not an invented "Building"', () => {
    const r = run({ steps: [step({ label: 'Building the project', skill: 'build.run' })] });
    assert.equal(latticeStatusFor(r).verb, 'Testing');
  });

  test('a finished first step with a second not yet started describes the running one', () => {
    const r = run({
      steps: [
        step({ label: 'Opened the folder', skill: 'files.open', state: 'done' }),
        step({ label: 'Reading the file', skill: 'files.readText', state: 'running' }),
      ],
    });
    assert.deepEqual(latticeStatusFor(r), {
      phase: 'active',
      verb: 'Working',
      label: 'Reading the file',
    });
  });
});

describe('latticeStatusFor — resolution', () => {
  test('every step done reads as a real success, not an assumed one', () => {
    const r = run({
      state: 'done',
      steps: [
        step({ label: 'a', state: 'done' }),
        step({ label: 'b', state: 'done' }),
      ],
    });
    const s = latticeStatusFor(r);
    assert.equal(s.phase, 'success');
    assert.equal(s.verb, 'Done');
    assert.equal(s.label, 'Ran 2 actions');
  });

  test('a failed step reads as an error even though `run.state` itself only ever says "done"', () => {
    // useActivity's `engine:done` handler calls finish('done') unconditionally
    // — it never reads the PlanOutcome — so `run.state` alone cannot tell a
    // real failure from a real success. The steps themselves can.
    const r = run({
      state: 'done',
      steps: [step({ label: 'a', state: 'done' }), step({ label: 'b', state: 'failed' })],
    });
    const s = latticeStatusFor(r);
    assert.equal(s.phase, 'error');
    assert.equal(s.verb, 'Error');
    assert.equal(s.label, '1 of 2 actions completed');
  });

  test('a halt mid-step marks that step halted, and the lattice reflects it', () => {
    const r = run({
      state: 'halted',
      steps: [step({ label: 'a', state: 'done' }), step({ label: 'b', state: 'halted' })],
    });
    assert.equal(latticeStatusFor(r).phase, 'halted');
    assert.equal(latticeStatusFor(r).verb, 'Stopped');
  });

  test('a halt that lands after the last step already finished has no halted step, only run.state', () => {
    // The executor never emits an event for a step that never started (see
    // `activity.test.ts`'s own halt test), so a stop between two steps can
    // leave every step in `run.steps` looking perfectly ordinary. `run.state`
    // is the only place that halt is recorded.
    const r = run({ state: 'halted', steps: [step({ label: 'a', state: 'done' })] });
    assert.equal(latticeStatusFor(r).phase, 'halted');
  });
});

// ── The same two outcomes, driven by a real Executor ─────────────────────────

function skill(id: string, run: Skill['run'], risk: Skill['risk'] = 'safe'): Skill {
  return { id, label: id, domain: id.split('.')[0]!, description: id, risk, params: {}, run };
}

function plan(...ids: string[]): Plan {
  return { source: 'grammar', intent: 'test', confidence: 1, steps: ids.map((s) => ({ skill: s, args: {} })) };
}

function context(overrides: Partial<SkillContext> = {}): SkillContext {
  return { say: () => {}, confirm: async () => true, ...overrides } as SkillContext;
}

/** The reduction `useActivity` does, kept intentionally minimal for this test only. */
function runFromEvents(events: ActivityEvent[], finalState: ActivityRun['state']): ActivityRun {
  const steps: ActivityStep[] = [];
  for (const e of events) {
    if (e.childId) continue; // this test never produces sub-steps
    steps[e.index] = {
      id: `s${e.index}`,
      label: e.label,
      detail: e.detail,
      state: e.state,
      startedAt: e.at,
      skill: e.skill,
    };
  }
  return { id: 'r', request: 'test', startedAt: 0, steps, state: finalState };
}

describe('latticeStatusFor — against a real Executor run', () => {
  test('a real failure resolves to error, with the real skill’s own error as the summary source', async () => {
    const registry = new SkillRegistry({ capabilities: () => [] });
    registry.registerMany([
      skill('a.one', async () => ({ ok: true, message: 'did one' })),
      skill('a.two', async () => ({ ok: false, error: 'No such file.' })),
    ]);
    const events: ActivityEvent[] = [];
    await new Executor(registry).run(plan('a.one', 'a.two'), context(), {
      onActivity: (e) => events.push(e),
    });

    const status = latticeStatusFor(runFromEvents(events, 'done'));
    assert.equal(status.phase, 'error');
    assert.equal(status.verb, 'Error');
  });

  test('a real halt resolves to halted, from a real HaltController abort', async () => {
    const halt = new HaltController();
    const registry = new SkillRegistry({ capabilities: () => [] });
    registry.registerMany([
      skill('a.one', async () => ({ ok: true, message: 'opened it' })),
      skill('a.two', async () => ({ ok: true })),
    ]);
    const events: ActivityEvent[] = [];
    await new Executor(registry).run(
      plan('a.one', 'a.two'),
      context({ say: (t: string) => t === 'opened it' && halt.abort() }),
      { signal: halt.signal, onActivity: (e) => events.push(e) },
    );

    const status = latticeStatusFor(runFromEvents(events, 'halted'));
    assert.equal(status.phase, 'halted');
    assert.equal(status.verb, 'Stopped');
  });
});

describe('latticeStatusFor — no channel for anything beyond phase/verb/label', () => {
  test('the returned shape is exactly {phase, verb, label} for a real run, active or resolved', () => {
    const allowed = new Set(['phase', 'verb', 'label']);
    const cases: (ActivityRun | null)[] = [
      null,
      run({ steps: [] }),
      run({ steps: [step({ label: 'x' })] }),
      run({ state: 'done', steps: [step({ label: 'x', state: 'done' })] }),
      run({ state: 'halted', steps: [step({ label: 'x', state: 'halted' })] }),
    ];
    for (const c of cases) {
      const status = latticeStatusFor(c);
      for (const key of Object.keys(status)) {
        assert.isTrue(allowed.has(key), `unexpected key "${key}" on the lattice status`);
      }
    }
  });

  test('the label is always either a real step’s own label or `summarizeRun`’s output — never free text', () => {
    const stepLabel = 'Searching the web';
    const active = latticeStatusFor(run({ steps: [step({ label: stepLabel })] }));
    assert.equal(active.label, stepLabel);

    const resolved = latticeStatusFor(
      run({ state: 'done', steps: [step({ label: stepLabel, state: 'done' })] }),
    );
    // `summarizeRun`'s own vocabulary — counts and a fixed phrase, not a
    // model's words.
    assert.match(resolved.label ?? '', /^Ran \d+ actions?$/);
  });
});
