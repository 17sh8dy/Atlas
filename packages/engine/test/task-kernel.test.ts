/**
 * The task kernel: ordering, failure, retry, cancellation, the emergency stop, recovery — and,
 * above all, that every step of a task goes through the one validated executor.
 *
 * These run against a REAL Engine and a real Executor. The only thing faked is the set of skills.
 */
import { describe, expect, test } from 'vitest';
import type { ExecutionMode, Plan, Skill, SkillArgs, Storage, Task, TaskPlan, TaskStepSpec } from '@atlas/core';
import { Engine, type EngineIO } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { SkillRegistry } from '../src/skills/registry';
import { TaskKernel, TaskPlanError, describeTask } from '../src/task/kernel';
import { TaskStore } from '../src/task/store';
import { checkGraph, dependentsOf, nextReady, orderedSteps } from '../src/task/graph';
import { RECIPES, findRecipe } from '../src/task/recipes';
import { taskPlanFromPlan, taskViewFromSetupChecks, taskViewFromWatch } from '../src/task/adapters';
import { createTaskSkills } from '../src/skills/task-skills';

// ── rig ────────────────────────────────────────────────────────────────────

function memoryStorage(): Storage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      return data.has(key) ? (structuredClone(data.get(key)) as T) : undefined;
    },
    async set(key: string, value: unknown) {
      data.set(key, structuredClone(value));
    },
    async remove(key: string) {
      data.delete(key);
    },
  } as unknown as Storage & { data: Map<string, unknown> };
}

interface Rig {
  engine: Engine;
  kernel: TaskKernel;
  storage: ReturnType<typeof memoryStorage>;
  ran: string[];
  asked: string[];
  said: string[];
  io: EngineIO;
  setMode(m: ExecutionMode): void;
  newKernel(): TaskKernel;
}

function skill(
  id: string,
  run: Skill['run'],
  extra: Partial<Skill> = {},
): Skill {
  return { id, label: id, domain: id.split('.')[0]!, description: id, risk: 'safe', params: {}, run, ...extra };
}

function rig(
  build: (ran: string[]) => Skill[],
  options: { mode?: ExecutionMode; answers?: boolean[]; storage?: ReturnType<typeof memoryStorage> } = {},
): Rig {
  let mode: ExecutionMode = options.mode ?? 'doIt';
  const ran: string[] = [];
  const asked: string[] = [];
  const said: string[] = [];
  const answers = [...(options.answers ?? [])];
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany(build(ran));
  const engine = new Engine({ skills: registry, grammar: new Grammar(), getExecutionMode: () => mode });
  const storage = options.storage ?? memoryStorage();
  let clock = 1_000;
  const newKernel = () =>
    new TaskKernel({
      host: engine.taskHost(),
      store: new TaskStore(storage),
      skills: registry,
      now: () => ++clock,
      sleep: async () => {},
    });
  const io: EngineIO = {
    say: (t) => said.push(t),
    confirm: async (q) => {
      asked.push(q);
      return answers.length ? answers.shift()! : true;
    },
  };
  return { engine, kernel: newKernel(), storage, ran, asked, said, io, setMode: (m) => (mode = m), newKernel };
}

const step = (id: string, skillId: string, extra: Partial<TaskStepSpec> = {}): TaskStepSpec => ({ id, skill: skillId, args: {}, ...extra });
const plan = (steps: TaskStepSpec[], extra: Partial<TaskPlan> = {}): TaskPlan => ({ goal: 'test task', source: 'recipe', steps, ...extra });
const status = (t: Task, id: string) => t.steps.find((s) => s.id === id)!.status;

const read = (id: string) => (ran: string[]) => skill(id, async () => (ran.push(id), { ok: true, message: `ran ${id}` }));
const write = (id: string) => (ran: string[]) => skill(id, async () => (ran.push(id), { ok: true, message: `ran ${id}` }), { risk: 'confirm' });

// ── graph ──────────────────────────────────────────────────────────────────

describe('the graph', () => {
  test('a good graph is accepted', () => {
    expect(checkGraph([step('a', 'x'), step('b', 'x', { dependsOn: ['a'] })])).toEqual({ ok: true });
  });

  test('duplicates, missing and self dependencies, cycles, emptiness and size are refused', () => {
    const errs = (steps: TaskStepSpec[]) => {
      const r = checkGraph(steps);
      return r.ok ? [] : r.errors.join(' | ');
    };
    expect(errs([step('a', 'x'), step('a', 'x')])).toMatch(/both called/);
    expect(errs([step('a', 'x', { dependsOn: ['zzz'] })])).toMatch(/not in the task/);
    expect(errs([step('a', 'x', { dependsOn: ['a'] })])).toMatch(/depends on itself/);
    expect(errs([step('a', 'x', { dependsOn: ['b'] }), step('b', 'x', { dependsOn: ['a'] })])).toMatch(/circle/);
    expect(errs([step('a', 'x', { dependsOn: ['c'] }), step('b', 'x', { dependsOn: ['a'] }), step('c', 'x', { dependsOn: ['b'] })])).toMatch(/circle: \w → \w → \w → \w\./);
    expect(errs([])).toMatch(/at least one/);
    expect(errs(Array.from({ length: 40 }, (_, i) => step(`s${i}`, 'x')))).toMatch(/at most 25/);
  });

  test('a very long chain does not overflow the stack', () => {
    const steps = Array.from({ length: 25 }, (_, i) => step(`s${i}`, 'x', { dependsOn: i ? [`s${i - 1}`] : undefined }));
    expect(checkGraph(steps)).toEqual({ ok: true });
  });

  test('ordering puts prerequisites first and dependents are found transitively', () => {
    const steps = [step('c', 'x', { dependsOn: ['b'] }), step('b', 'x', { dependsOn: ['a'] }), step('a', 'x')];
    expect(orderedSteps(steps).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    const task = { steps: steps.map((s) => ({ ...s, label: s.id, status: 'pending' as const, attempts: 0, safeToRepeat: true })) };
    expect(dependentsOf(task, 'a').map((s) => s.id).sort()).toEqual(['b', 'c']);
    expect(nextReady(task)!.id).toBe('a');
  });
});

// ── running ────────────────────────────────────────────────────────────────

describe('dependency order', () => {
  test('steps run after what they depend on, whatever order they were listed in', async () => {
    const r = rig((ran) => [read('t.a')(ran), read('t.b')(ran), read('t.c')(ran)]);
    const task = await r.kernel.run(
      plan([step('c', 't.c', { dependsOn: ['b'] }), step('b', 't.b', { dependsOn: ['a'] }), step('a', 't.a')]),
      r.io,
    );
    expect(r.ran).toEqual(['t.a', 't.b', 't.c']);
    expect(task.status).toBe('done');
    expect(task.steps.every((s) => s.status === 'done')).toBe(true);
  });

  test('a failed prerequisite means its dependents are never tried', async () => {
    const r = rig((ran) => [
      skill('t.bad', async () => (ran.push('t.bad'), { ok: false, error: 'It is not found.' })),
      read('t.after')(ran),
      read('t.free')(ran),
    ]);
    const task = await r.kernel.run(
      plan([step('bad', 't.bad'), step('after', 't.after', { dependsOn: ['bad'] }), step('free', 't.free')], { onFailure: 'continue-independent' }),
      r.io,
    );
    expect(r.ran).toEqual(['t.bad', 't.free']);
    expect(status(task, 'after')).toBe('blocked');
    expect(task.steps.find((s) => s.id === 'after')!.reason).toMatch(/needs “t.bad”/);
    expect(task.status).toBe('partial');
  });

  test('by default the first failure ends the task and says what was not reached', async () => {
    const r = rig((ran) => [
      skill('t.bad', async () => (ran.push('t.bad'), { ok: false, error: 'It is not found.' })),
      read('t.free')(ran),
    ]);
    const task = await r.kernel.run(plan([step('bad', 't.bad'), step('free', 't.free')]), r.io);
    expect(r.ran).toEqual(['t.bad']);
    expect(status(task, 'free')).toBe('cancelled');
    expect(task.status).toBe('failed');
    expect(task.steps[0]!.failure).toBe('not-found');
  });
});

describe('retries', () => {
  const flaky = (failures: number, error: string) => (ran: string[]) => {
    let n = 0;
    return skill('t.flaky', async () => {
      ran.push('t.flaky');
      return ++n <= failures ? { ok: false, error } : { ok: true, message: 'ok' };
    });
  };

  test('a safe step that fails in a way that clears by itself is retried, up to the limit', async () => {
    const r = rig((ran) => [flaky(2, 'That file is in use by another program.')(ran)]);
    const task = await r.kernel.run(plan([step('f', 't.flaky', { retry: { max: 2 } })]), r.io);
    expect(r.ran).toEqual(['t.flaky', 't.flaky', 't.flaky']);
    expect(task.status).toBe('done');
    expect(task.steps[0]!.attempts).toBe(3);
  });

  test('the limit is a limit', async () => {
    const r = rig((ran) => [flaky(10, 'The request timed out.')(ran)]);
    const task = await r.kernel.run(plan([step('f', 't.flaky', { retry: { max: 1 } })]), r.io);
    expect(r.ran).toHaveLength(2);
    expect(task.status).toBe('failed');
    expect(task.steps[0]!.failure).toBe('timeout');
  });

  test('a failure that will not clear by itself is not retried, however it was asked', async () => {
    const r = rig((ran) => [flaky(10, 'That path does not exist.')(ran)]);
    await r.kernel.run(plan([step('f', 't.flaky', { retry: { max: 5 } })]), r.io);
    expect(r.ran).toHaveLength(1);
  });

  test('a step that is not safe to repeat is never retried, even for a transient failure', async () => {
    const r = rig((ran) => {
      let n = 0;
      return [
        skill('t.write', async () => (ran.push('t.write'), ++n < 3 ? { ok: false, error: 'The file is in use.' } : { ok: true }), { risk: 'confirm' }),
      ];
    });
    const task = await r.kernel.run(plan([step('w', 't.write', { retry: { max: 5 } })]), r.io);
    expect(r.ran).toEqual(['t.write']);
    expect(task.status).toBe('failed');
  });
});

describe('cancellation', () => {
  test('a cancel stops before the next step and says why the rest did not run', async () => {
    let kernel: TaskKernel | null = null;
    const r = rig((ran) => [
      skill('t.first', async () => {
        ran.push('t.first');
        kernel!.cancel(kernel!.running!);
        return { ok: true };
      }),
      read('t.second')(ran),
    ]);
    kernel = r.kernel;
    const task = await r.kernel.run(plan([step('a', 't.first'), step('b', 't.second', { dependsOn: ['a'] })]), r.io);
    expect(r.ran).toEqual(['t.first']);
    expect(task.status).toBe('cancelled');
    expect(status(task, 'a')).toBe('done');
    expect(status(task, 'b')).toBe('cancelled');
    expect(task.steps[1]!.reason).toMatch(/you cancelled/);
  });

  test('cancelling nothing is a no-op', () => {
    const r = rig(() => []);
    expect(r.kernel.cancel('nope')).toBe(false);
  });
});

// ── the emergency stop and recovery ────────────────────────────────────────

describe('F8 and recovery', () => {
  /** A task whose second step never finishes by itself — the stop has to end it. */
  function hanging(second: { risk: Skill['risk'] }) {
    let release: () => void = () => {};
    const r = rig((ran) => [
      read('t.first')(ran),
      skill(
        't.hang',
        () =>
          new Promise((resolve) => {
            ran.push('t.hang');
            release = () => resolve({ ok: true });
          }),
        { risk: second.risk },
      ),
      read('t.last')(ran),
    ]);
    return { r, release: () => release() };
  }
  const threeSteps = plan([step('a', 't.first'), step('b', 't.hang', { dependsOn: ['a'] }), step('c', 't.last', { dependsOn: ['b'] })]);

  test('a stop mid-step interrupts the task and nothing after it starts', async () => {
    const { r } = hanging({ risk: 'safe' });
    const running = r.kernel.run(threeSteps, r.io);
    await new Promise((x) => setTimeout(x, 30));
    r.engine.halt();
    const task = await running;
    expect(task.status).toBe('interrupted');
    expect(r.ran).toEqual(['t.first', 't.hang']);
    expect(status(task, 'a')).toBe('done');
    expect(status(task, 'c')).toBe('pending');
  });

  test('a harmless step that was in flight may be run again; a consequential one is unknown', async () => {
    const safe = hanging({ risk: 'safe' });
    const a = safe.r.kernel.run(threeSteps, safe.r.io);
    await new Promise((x) => setTimeout(x, 30));
    safe.r.engine.halt();
    expect(status(await a, 'b')).toBe('pending');

    const unsafe = hanging({ risk: 'confirm' });
    const b = unsafe.r.kernel.run(threeSteps, unsafe.r.io);
    await new Promise((x) => setTimeout(x, 30));
    unsafe.r.engine.halt();
    const task = await b;
    expect(status(task, 'b')).toBe('uncertain');
    expect(task.steps[1]!.reason).toMatch(/can’t tell whether it happened/);
  });

  test('resuming without an answer never re-runs the unknown step', async () => {
    const { r } = hanging({ risk: 'confirm' });
    const running = r.kernel.run(threeSteps, r.io);
    await new Promise((x) => setTimeout(x, 30));
    r.engine.halt();
    const stopped = await running;
    const before = [...r.ran];

    const again = await r.kernel.resume(stopped.id, r.io, {});
    expect(again.status).toBe('awaiting');
    expect(r.ran).toEqual(before);
    expect(status(again, 'b')).toBe('uncertain');
  });

  test('"it already happened" finishes the step without running it, and the task carries on', async () => {
    const { r } = hanging({ risk: 'confirm' });
    const running = r.kernel.run(threeSteps, r.io);
    await new Promise((x) => setTimeout(x, 30));
    r.engine.halt();
    const stopped = await running;
    const done = await r.kernel.resume(stopped.id, r.io, { b: 'treat-as-done' });
    expect(r.ran).toEqual(['t.first', 't.hang', 't.last']);
    expect(done.status).toBe('done');
    expect(done.steps[1]!.reason).toMatch(/already happened/);
    expect(done.steps[1]!.verified).toBeUndefined();
  });

  test('"skip" leaves it unrun and blocks what depended on it', async () => {
    const { r } = hanging({ risk: 'confirm' });
    const running = r.kernel.run(threeSteps, r.io);
    await new Promise((x) => setTimeout(x, 30));
    r.engine.halt();
    const stopped = await running;
    const task = await r.kernel.resume(stopped.id, r.io, { b: 'skip' });
    expect(r.ran).toEqual(['t.first', 't.hang']);
    expect(status(task, 'b')).toBe('skipped');
    expect(status(task, 'c')).toBe('blocked');
    expect(task.status).toBe('partial');
  });

  test('"run it again" goes through the executor, which asks again like any step', async () => {
    const { r } = hanging({ risk: 'confirm' });
    const running = r.kernel.run(threeSteps, r.io);
    // The first run's confirm card is answered "yes" (default), then the step hangs.
    await new Promise((x) => setTimeout(x, 30));
    r.engine.halt();
    const stopped = await running;
    const cardsBefore = r.asked.length;
    // The second attempt would hang again; answer the card "no" instead and see it is asked.
    const answers = [false];
    r.io.confirm = async (q) => (r.asked.push(q), answers.shift() ?? true);
    const task = await r.kernel.resume(stopped.id, r.io, { b: 'retry' });
    expect(r.asked.length).toBeGreaterThan(cardsBefore);
    expect(status(task, 'b')).toBe('skipped');
    expect(task.status).toBe('cancelled');
  });

  test('a task cut off by a crash is found interrupted, and what was in flight is not repeated', async () => {
    const storage = memoryStorage();
    const r = rig((ran) => [read('t.first')(ran), write('t.write')(ran), read('t.last')(ran)], { storage });
    // Simulate Atlas dying while t.write was in flight: the store says "running".
    const crashed: Task = {
      id: 'crash',
      goal: 'cut off',
      source: 'recipe',
      onFailure: 'stop',
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      steps: [
        { id: 'a', skill: 't.first', args: {}, label: 'a', status: 'done', attempts: 1, safeToRepeat: true },
        { id: 'b', skill: 't.write', args: {}, label: 'b', status: 'running', attempts: 1, safeToRepeat: false, dependsOn: ['a'] },
        { id: 'c', skill: 't.last', args: {}, label: 'c', status: 'pending', attempts: 0, safeToRepeat: true, dependsOn: ['b'] },
      ],
    };
    await new TaskStore(storage).save(crashed);

    const fresh = r.newKernel();
    const found = (await fresh.list()).find((t) => t.id === 'crash')!;
    expect(found.status).toBe('interrupted');
    expect(status(found, 'b')).toBe('uncertain');
    expect(r.ran).toEqual([]);

    const resumed = await fresh.resume('crash', r.io, {});
    expect(resumed.status).toBe('awaiting');
    expect(r.ran).toEqual([]);
  });
});

// ── partial completion and verification ────────────────────────────────────

describe('what the report claims', () => {
  test('a partly finished task says which steps finished, which failed and which never ran', async () => {
    const r = rig((ran) => [
      read('t.ok')(ran),
      skill('t.bad', async () => ({ ok: false, error: 'It is not found.' })),
      read('t.never')(ran),
    ]);
    const task = await r.kernel.run(
      plan([step('a', 't.ok'), step('b', 't.bad', { dependsOn: ['a'] }), step('c', 't.never', { dependsOn: ['b'] })]),
      r.io,
    );
    const text = describeTask(task);
    expect(task.status).toBe('partial');
    expect(text).toMatch(/Partly done/);
    expect(text).toMatch(/1 of 3 steps finished/);
    expect(text).toMatch(/✓ t.ok/);
    expect(text).toMatch(/✗ t.bad — It is not found/);
    expect(text).toMatch(/– t.never — stopped after “t.bad” failed/);
  });

  test('"confirmed" is only said where the result was read back', async () => {
    const registry = new SkillRegistry({ capabilities: () => [] });
    registry.registerMany([
      skill('t.checked', async () => ({ ok: true }), {
        verify: () => [{ kind: 'path-exists', path: 'D:\\x\\there.txt' }],
      }),
      skill('t.unchecked', async () => ({ ok: true })),
    ]);
    const engine = new Engine({
      skills: registry,
      grammar: new Grammar(),
      probes: async (specs) => specs.map((probe) => ({ probe, state: 'confirmed' as const, evidence: 'there.txt is there' })),
    });
    const kernel = new TaskKernel({ host: engine.taskHost(), store: new TaskStore(memoryStorage()), skills: registry });
    const io: EngineIO = { say: () => {}, confirm: async () => true };
    const task = await kernel.run(plan([step('a', 't.checked'), step('b', 't.unchecked', { dependsOn: ['a'] })]), io);
    expect(task.steps[0]!.verified).toBe('confirmed');
    expect(task.steps[1]!.verified).toBeUndefined();
    const text = describeTask(task);
    expect(text).toMatch(/1 confirmed by reading the result back/);
    expect(text).toMatch(/1 reported done without a way to check/);
    expect(text).toMatch(/t.checked — confirmed: there.txt is there/);
  });
});

// ── every step goes through the executor ───────────────────────────────────

describe('every step passes through the validated executor', () => {
  test('a task is refused whole, with nothing run or saved, if any step names an unknown skill', async () => {
    const r = rig((ran) => [read('t.ok')(ran)]);
    await expect(r.kernel.run(plan([step('a', 't.ok'), step('b', 'nothing.like.this')]), r.io)).rejects.toBeInstanceOf(TaskPlanError);
    expect(r.ran).toEqual([]);
    expect((await r.kernel.list()).length).toBe(0);
  });

  test('arguments are validated and coerced by the registry, and a missing one refuses the task', async () => {
    const seen: SkillArgs[] = [];
    const r = rig(() => [
      skill('t.count', async (a) => (seen.push(a), { ok: true }), {
        params: { n: { type: 'number', required: true, description: 'n' }, flag: { type: 'boolean', required: false, description: 'f' } },
      }),
    ]);
    await r.kernel.run(plan([{ id: 'a', skill: 't.count', args: { n: '5', flag: 'yes', invented: 'x' } }]), r.io);
    expect(seen).toEqual([{ n: 5, flag: true }]);
    await expect(r.kernel.run(plan([{ id: 'a', skill: 't.count', args: {} }]), r.io)).rejects.toThrow(/needs “n”/);
  });

  test('in Do It? a consequential step asks, and a "no" ends the task', async () => {
    const r = rig((ran) => [read('t.a')(ran), write('t.w')(ran), read('t.c')(ran)], { answers: [false] });
    const task = await r.kernel.run(plan([step('a', 't.a'), step('w', 't.w', { dependsOn: ['a'] }), step('c', 't.c', { dependsOn: ['w'] })]), r.io);
    expect(r.asked.length).toBe(1);
    expect(r.ran).toEqual(['t.a']);
    expect(task.status).toBe('cancelled');
    expect(status(task, 'w')).toBe('skipped');
    expect(status(task, 'c')).toBe('cancelled');
  });

  test('a skill that refuses on its own terms is refused inside a task, and nothing after it runs', async () => {
    const r = rig((ran) => [
      skill('t.guarded', async () => (ran.push('t.guarded'), { ok: true }), { risk: 'confirm', guard: () => 'That is not something I will do.' }),
      read('t.after')(ran),
    ]);
    const task = await r.kernel.run(plan([step('g', 't.guarded'), step('a', 't.after', { dependsOn: ['g'] })]), r.io);
    expect(r.ran).toEqual([]);
    expect(r.asked).toEqual([]);
    expect(task.steps[0]!.status).toBe('failed');
    expect(task.steps[0]!.failure).toBe('refused');
    expect(status(task, 'a')).toBe('cancelled');
  });

  test('Plan First shows the whole task once, then runs it with no per-step cards', async () => {
    const r = rig((ran) => [write('t.w1')(ran), write('t.w2')(ran), read('t.r')(ran)], { mode: 'planFirst' });
    const task = await r.kernel.run(
      plan([step('w1', 't.w1'), step('w2', 't.w2', { dependsOn: ['w1'] }), step('r', 't.r', { dependsOn: ['w2'] })]),
      r.io,
    );
    expect(r.asked.length).toBe(1);
    expect(r.asked[0]).toMatch(/Run this plan/);
    expect(r.ran).toEqual(['t.w1', 't.w2', 't.r']);
    expect(task.status).toBe('done');
  });

  test('Plan First: declining the card runs nothing', async () => {
    const r = rig((ran) => [write('t.w1')(ran)], { mode: 'planFirst', answers: [false] });
    const task = await r.kernel.run(plan([step('w1', 't.w1')]), r.io);
    expect(r.ran).toEqual([]);
    expect(task.status).toBe('cancelled');
    expect(task.steps[0]!.reason).toBe('you said no');
  });

  test('Plan First: a harmless-only task shows no card at all', async () => {
    const r = rig((ran) => [read('t.a')(ran), read('t.b')(ran)], { mode: 'planFirst' });
    await r.kernel.run(plan([step('a', 't.a'), step('b', 't.b', { dependsOn: ['a'] })]), r.io);
    expect(r.asked).toEqual([]);
    expect(r.ran).toEqual(['t.a', 't.b']);
  });

  test('Confirm Actions: a task is never approval — every consequential step asks on its own', async () => {
    const r = rig((ran) => [write('t.w1')(ran), write('t.w2')(ran)], { mode: 'confirmActions' });
    await r.kernel.run(plan([step('w1', 't.w1'), step('w2', 't.w2', { dependsOn: ['w1'] })]), r.io);
    expect(r.asked.length).toBe(2);
    expect(r.ran).toEqual(['t.w1', 't.w2']);
  });

  test('Do It +: routine work runs without asking, and the always-ask list still asks', async () => {
    const r = rig((ran) => [write('t.build')(ran), write('files.delete')(ran)], { mode: 'doItPlus' });
    await r.kernel.run(plan([step('b', 't.build'), step('d', 'files.delete', { dependsOn: ['b'] })]), r.io);
    expect(r.ran).toEqual(['t.build', 'files.delete']);
    expect(r.asked.length).toBe(1);
  });

  test('the kernel never invokes a skill itself: its source reaches the machine only through host.run', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(__dirname, '..', 'src', 'task');
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(dir, name), 'utf8');
      expect(text, name).not.toMatch(/\.invoke\(/);
      expect(text, name).not.toMatch(/new Executor\b/);
      expect(text, name).not.toMatch(/\.run\(\s*step\b|skill\.run\(/);
      expect(text, name).not.toMatch(/@atlas\/platform|platform\.(?:open|launch|createFile|deletePath)/);
    }
    const kernel = readFileSync(join(dir, 'kernel.ts'), 'utf8');
    expect(kernel).toMatch(/this\.host\.run\(/);
  });
});

// ── compatibility ──────────────────────────────────────────────────────────

describe('compatibility with plans, watches and setups', () => {
  test('a plan from any source becomes a linear task, and runs through the same path', async () => {
    const p: Plan = { source: 'ai', intent: 'do two things', confidence: 0.9, steps: [{ skill: 't.a', args: {} }, { skill: 't.b', args: {} }] };
    const tp = taskPlanFromPlan(p);
    expect(tp.source).toBe('ai');
    expect(tp.steps.map((s) => s.dependsOn)).toEqual([undefined, ['s1']]);
    const r = rig((ran) => [read('t.a')(ran), read('t.b')(ran)]);
    const task = await r.kernel.run(tp, r.io);
    expect(r.ran).toEqual(['t.a', 't.b']);
    expect(task.source).toBe('ai');
  });

  test('a model-shaped plan with a bad step is refused like any other', async () => {
    const p: Plan = { source: 'ai', intent: 'x', confidence: 0.9, steps: [{ skill: 't.a', args: {} }, { skill: 'made.up', args: {} }] };
    const r = rig((ran) => [read('t.a')(ran)]);
    await expect(r.kernel.run(taskPlanFromPlan(p), r.io)).rejects.toBeInstanceOf(TaskPlanError);
    expect(r.ran).toEqual([]);
  });

  test('a watch is shown in the shared vocabulary without being re-run', () => {
    const view = taskViewFromWatch({
      id: 'w1',
      request: 'when the build finishes, run the tests',
      describe: 'cargo finishes',
      condition: { kind: 'process-exits', name: 'cargo' },
      steps: [{ skill: 'a', args: {} }, { skill: 'b', args: {} }, { skill: 'c', args: {} }],
      stepLabels: ['one', 'two', 'three'],
      stepStates: ['done', 'started', 'pending'],
      approval: 'x',
      status: 'running',
      createdAt: 1,
      expiresAt: 2,
      baseline: { startedAt: 1 },
      log: [],
    } as never);
    expect(view.kind).toBe('watch');
    expect(view.status).toBe('running');
    // A step written down as started and never finished is an unknown one, not a finished one.
    expect(view.steps.map((s) => s.status)).toEqual(['done', 'uncertain', 'pending']);
  });

  test('a setup’s checks are confirmed by construction; skipped ones are not counted as done', () => {
    const view = taskViewFromSetupChecks(
      'recording',
      [
        { item: { kind: 'open', app: 'OBS' }, ok: true, observed: 'OBS is running' },
        { item: { kind: 'close', app: 'Chrome' }, ok: true, observed: 'Chrome wasn’t running', skipped: true },
        { item: { kind: 'online' }, ok: false, observed: 'No internet' },
      ],
      (c) => c.observed,
    );
    expect(view.steps.map((s) => s.status)).toEqual(['done', 'skipped', 'failed']);
    expect(view.steps[0]!.verified).toBe('confirmed');
    expect(view.steps[1]!.verified).toBeUndefined();
    expect(view.status).toBe('partial');
  });
});

// ── recipes and skills ─────────────────────────────────────────────────────

describe('recipes', () => {
  test('every recipe builds a valid, read-only plan', () => {
    for (const recipe of RECIPES) {
      const params = Object.fromEntries(Object.entries(recipe.params).map(([k]) => [k, 'D:\\Dev']));
      const p = recipe.build(params);
      expect(checkGraph(p.steps), recipe.id).toEqual({ ok: true });
      expect(p.source).toBe('recipe');
      expect(new Set(p.steps.map((s) => s.id)).size, recipe.id).toBe(p.steps.length);
    }
  });

  test('a recipe that needs a folder says so instead of guessing one', () => {
    expect(() => findRecipe('space-review')!.build({})).toThrow(/needs a folder/);
    expect(findRecipe('nope')).toBeNull();
  });

  test('the report waits for both reads it quotes', () => {
    const p = findRecipe('pc-checkup')!.build({});
    expect(p.steps.find((s) => s.id === 'report')!.dependsOn).toEqual(['load', 'errors']);
  });
});

describe('the task skills', () => {
  function withSkills() {
    const r = rig((ran) => [
      read('system.metrics')(ran),
      read('system.errors')(ran),
      read('system.report')(ran),
    ]);
    const registry = r.engine.skills;
    registry.registerMany(createTaskSkills(r.kernel));
    return { r, registry };
  }
  const ctx = (r: Rig) => ({ say: r.io.say, confirm: r.io.confirm }) as never;

  test('task.run runs a recipe through the kernel and reports it', async () => {
    const { r, registry } = withSkills();
    const out = await registry.invoke('task.run', { recipe: 'pc-checkup' }, ctx(r));
    expect(out.ok).toBe(true);
    expect(r.ran).toEqual(['system.metrics', 'system.errors', 'system.report']);
    expect(out.message).toMatch(/Done — Check how this PC is doing/);
  });

  test('an unknown recipe, or one missing its folder, fails without running anything', async () => {
    const { r, registry } = withSkills();
    expect((await registry.invoke('task.run', { recipe: 'space-review' }, ctx(r))).error).toMatch(/needs a folder/);
    expect(r.ran).toEqual([]);
  });

  test('task.list and task.resume are read-only and say so when there is nothing to do', async () => {
    const { r, registry } = withSkills();
    expect((await registry.invoke('task.list', {}, ctx(r))).message).toMatch(/No tasks yet/);
    expect((await registry.invoke('task.resume', {}, ctx(r))).message).toMatch(/no stopped task/);
  });
});
