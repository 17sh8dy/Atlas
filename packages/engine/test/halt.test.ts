/**
 * The emergency stop, as the engine sees it.
 *
 * The native half (latch, killed processes, dropped requests) is tested in
 * `halt.rs` against real processes and a real key press. These tests cover
 * the other half: that once `engine.halt()` is called, nothing further starts
 * and every run returns promptly — whatever it was waiting on at the time.
 *
 * "Promptly" is measured, not assumed. The budget for the whole stop is one
 * second; the engine's share of it is asserted at 50ms.
 */

import { test, assert } from 'vitest';
import type { IntelligenceProvider, Plan, Skill, SkillContext } from '@atlas/core';
import { Engine, type EngineIO } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { SkillRegistry } from '../src/skills/registry';
import { Executor } from '../src/planner/executor';
import { SimpleIntelligenceRegistry } from '../src/intelligence-registry';
import { runDevTask } from '../src/devagent/loop';

const ENGINE_BUDGET_MS = 50;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function skill(id: string, run: Skill['run'], risk: Skill['risk'] = 'safe'): Skill {
  return { id, label: id, domain: id.split('.')[0]!, description: id, risk, params: {}, run };
}

function io(overrides: Partial<EngineIO> = {}): EngineIO & { said: string[] } {
  const said: string[] = [];
  return { say: (t) => said.push(t), confirm: async () => true, said, ...overrides };
}

function engineWith(skills: Skill[], provider?: IntelligenceProvider) {
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany(skills);
  const intelligence = new SimpleIntelligenceRegistry();
  if (provider) {
    intelligence.register(provider);
    intelligence.setActive(provider.id);
  }
  return new Engine({ skills: registry, grammar: new Grammar(), intelligence });
}

const plan = (...ids: string[]): Plan => ({
  source: 'direct',
  intent: 'test',
  confidence: 1,
  steps: ids.map((skill) => ({ skill, args: {} })),
});

async function haltAndTime<T>(engine: Engine, running: Promise<T>): Promise<{ result: T; ms: number }> {
  const pressed = performance.now();
  engine.halt();
  const result = await running;
  return { result, ms: performance.now() - pressed };
}

test('an action chain stops between steps: nothing queued after the halt starts', async () => {
  const ran: string[] = [];
  let release!: () => void;
  const engine = engineWith([
    skill('a.one', async () => {
      ran.push('one');
      await new Promise<void>((r) => (release = r));
      return { ok: true };
    }),
    skill('a.two', async () => (ran.push('two'), { ok: true })),
    skill('a.three', async () => (ran.push('three'), { ok: true })),
  ]);
  const surface = io();

  const running = engine.run(plan('a.one', 'a.two', 'a.three'), surface);
  await tick();
  const { result, ms } = await haltAndTime(engine, running);
  release(); // the abandoned step finishing late must not revive the plan
  await tick(20);

  assert.isBelow(ms, ENGINE_BUDGET_MS);
  assert.deepEqual(ran, ['one']);
  assert.isTrue(result.halted);
  assert.isTrue(result.aborted);
  assert.deepEqual(
    result.outcomes.map((o) => [o.skill, o.skipped, o.error]),
    [
      ['a.one', true, 'Halted.'],
      ['a.two', true, 'Halted.'],
      ['a.three', true, 'Halted.'],
    ],
  );
});

test('a step that ignores the signal is abandoned on time rather than awaited', async () => {
  const engine = engineWith([
    // Never resolves and never looks at ctx.signal: the worst-behaved step there is.
    skill('slow.forever', () => new Promise(() => {})),
  ]);
  const running = engine.run(plan('slow.forever'), io());
  await tick();
  const { result, ms } = await haltAndTime(engine, running);
  assert.isBelow(ms, ENGINE_BUDGET_MS);
  assert.isTrue(result.halted);
});

test('a step can see the halt through ctx.signal and stop its own loop', async () => {
  let iterations = 0;
  let sawAbort = false;
  const engine = engineWith([
    skill('loop.poll', async (_args, ctx: SkillContext) => {
      while (!ctx.signal?.aborted) {
        iterations++;
        await tick(2);
      }
      sawAbort = true;
      return { ok: true };
    }),
  ]);
  const running = engine.run(plan('loop.poll'), io());
  await tick(20);
  await haltAndTime(engine, running);
  const frozen = iterations;
  await tick(20);
  assert.isTrue(sawAbort);
  assert.equal(iterations, frozen, 'no iteration after the halt');
});

test('an open confirm card is abandoned, and the risky step never runs', async () => {
  let ran = false;
  const engine = engineWith([skill('danger.do', async () => ((ran = true), { ok: true }), 'confirm')]);
  const surface = io({ confirm: () => new Promise<boolean>(() => {}) }); // nobody answers

  for (const mode of ['doIt', 'planFirst', 'confirmActions'] as const) {
    const e = new Engine({
      skills: engine.skills,
      grammar: new Grammar(),
      getExecutionMode: () => mode,
    });
    const running = e.run(plan('danger.do'), surface);
    await tick();
    const { result, ms } = await haltAndTime(e, running);
    assert.isBelow(ms, ENGINE_BUDGET_MS, mode);
    assert.isTrue(result.halted, mode);
  }
  assert.isFalse(ran);
});

test('a halt while waiting on a model that never answers returns at once, silently', async () => {
  const provider: IntelligenceProvider = {
    id: 'hung',
    label: 'Hung',
    isConfigured: () => true,
    isLocal: () => true,
    ask: () => {},
  };
  const engine = engineWith([], provider);
  const surface = io();
  let typing = false;
  surface.typing = (on) => (typing = on);

  const running = engine.ask('why is the sky blue?', surface);
  await tick();
  assert.isTrue(typing);
  const { result, ms } = await haltAndTime(engine, running);
  assert.isBelow(ms, ENGINE_BUDGET_MS);
  assert.deepEqual(result, { ok: false, mode: 'halted' });
  assert.isFalse(typing, 'the typing indicator is cleared');
  assert.deepEqual(surface.said, [], 'a halt is not followed by Atlas talking');
});

test('a streamed reply keeps what arrived, and nothing after the halt reaches the screen', async () => {
  let handlers!: Parameters<IntelligenceProvider['ask']>[1];
  let passedSignal: unknown;
  const provider: IntelligenceProvider = {
    id: 'stream',
    label: 'Stream',
    isConfigured: () => true,
    isLocal: () => true,
    ask: (_p, h, options) => {
      handlers = h;
      passedSignal = options?.signal;
    },
  };
  const engine = engineWith([], provider);
  const appended: string[] = [];
  let finished: string | null = null;
  const surface = io({
    stream: () => ({ append: (c) => appended.push(c), finish: (full) => (finished = full) }),
  });

  const running = engine.ask('tell me a story?', surface);
  await tick();
  assert.exists(passedSignal, 'the provider is handed the signal');
  handlers.onDelta('Once upon ');
  handlers.onDelta('a time');
  const { result } = await haltAndTime(engine, running);
  handlers.onDelta(' there was more');
  handlers.onDone('Once upon a time there was more');

  assert.equal(result.mode, 'halted');
  assert.deepEqual(appended, ['Once upon ', 'a time']);
  assert.equal(finished, 'Once upon a time');
  assert.deepEqual(surface.said, []);
});

test('the dev agent loop never starts another iteration after a halt', async () => {
  const registry = new SkillRegistry({ capabilities: () => [] });
  let builds = 0;
  registry.register({
    ...skill('build.run', async () => {
      builds++;
      await tick(10);
      return { ok: true, message: 'built' };
    }),
    params: { path: { type: 'string', required: false, description: 'p' } },
  });
  let asks = 0;
  const provider: IntelligenceProvider = {
    id: 'agent',
    label: 'Agent',
    isConfigured: () => true,
    isLocal: () => true,
    // Always wants another build: without the stop, this runs to the budget.
    ask: (_p, h) => {
      asks++;
      h.onDone(JSON.stringify({ skill: 'build.run', args: { path: String(asks) } }));
    },
  };
  const intelligence = new SimpleIntelligenceRegistry();
  intelligence.register(provider);
  intelligence.setActive('agent');

  const controller = new AbortController();
  const said: string[] = [];
  const ctx: SkillContext = {
    say: (t) => said.push(t),
    confirm: async () => true,
    signal: controller.signal,
  };
  const running = runDevTask(
    'keep building',
    'C:\\proj',
    { skills: registry, intelligence, executor: new Executor(registry), getExecutionMode: () => 'doIt' },
    ctx,
  );
  await tick(25);
  const pressed = performance.now();
  controller.abort();
  const report = await running;
  const ms = performance.now() - pressed;
  const buildsAtHalt = builds;
  await tick(40);

  assert.isBelow(ms, ENGINE_BUDGET_MS);
  assert.equal(report.stoppedBecause, 'halted');
  assert.equal(builds, buildsAtHalt, 'no build after the halt');
  assert.isAbove(buildsAtHalt, 0);
  assert.notInclude(said.join(' '), 'ran out of steps');
});

test('a halt with nothing running is harmless, and the next request runs normally', async () => {
  let ran = 0;
  const engine = engineWith([skill('ok.go', async () => (ran++, { ok: true, message: 'done' }))]);
  engine.halt();
  const outcome = await engine.run(plan('ok.go'), io());
  assert.isTrue(outcome.ok);
  assert.equal(ran, 1);
});
