/**
 * Atlas Watch — the manager's promises, pinned.
 *
 *  - only what was approved runs unattended, in order, once;
 *  - a step that was mid-flight when Atlas died is asked about, never repeated blind;
 *  - an *event* seen across a restart is asked about, a *state* is acted on;
 *  - a record edited after approval runs nothing;
 *  - the emergency stop pauses, and nothing resumes on its own;
 *  - a step the approval didn't cover (a bulk preview) stops and waits for the person.
 *
 * Everything runs against in-memory fakes: a process list the test edits, a
 * storage map that survives "restarts" (a new manager over the same map), and
 * a clock the test moves.
 */

import { describe, expect, test } from 'vitest';
import type {
  FileEntry,
  Plan,
  PlanOutcome,
  PlanStep,
  Platform,
  ProcessEntry,
  Storage,
  Watch,
} from '@atlas/core';
import { WatchManager, WATCHES_KEY, type WatchHost } from '../src/watch/manager';
import { fingerprintSteps, probeCondition, reliableAfterGap } from '../src/watch/conditions';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { SkillRegistry } from '../src/skills/registry';
import { createWatchSkills } from '../src/skills/watch-skills';

// ── fakes ──────────────────────────────────────────────────────────────────

function memoryStorage(): Storage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(k: string) => (data.has(k) ? (structuredClone(data.get(k)) as T) : undefined),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
}

interface World {
  processes: ProcessEntry[];
  downloads: FileEntry[];
  online: boolean;
}

function fakePlatform(world: World): Platform {
  return {
    capabilities: async () => [],
    runningProcesses: async () => world.processes,
    listDir: async () => world.downloads,
    knownFolder: async () => 'C:\\Users\\me\\Downloads',
    networkReachable: async () => world.online,
    listWindows: async () => [],
  } as unknown as Platform;
}

const proc = (name: string, pid = 100): ProcessEntry => ({ pid, name });

interface Host extends WatchHost {
  ran: PlanStep[];
  said: string[];
  notified: string[];
  /** What each step's run returns; default ok. */
  outcome?: (
    step: PlanStep,
    approved: boolean,
  ) => Partial<PlanOutcome> | Promise<Partial<PlanOutcome>>;
  /** Per step: was `approvedStep` true for it? */
  approvals: boolean[];
}

function fakeHost(): Host {
  const host: Host = {
    ran: [],
    said: [],
    notified: [],
    approvals: [],
    announce: (t) => void host.said.push(t),
    notify: (title, body) => void host.notified.push(`${title}: ${body}`),
    async run(plan: Plan, _io, extra): Promise<PlanOutcome> {
      const step = plan.steps[0]!;
      const approved = extra.approvedStep(step);
      host.approvals.push(approved);
      host.ran.push(step);
      const custom = host.outcome ? await host.outcome(step, approved) : {};
      return {
        ok: true,
        ran: 1,
        aborted: false,
        outcomes: [{ skill: step.skill, ok: true }],
        ...custom,
      };
    },
  };
  return host;
}

const STEPS: PlanStep[] = [
  { skill: 'test.run', args: { path: 'D:\\Dev\\App', system: 'pnpm' } },
  { skill: 'build.run', args: { path: 'D:\\Dev\\App', system: 'pnpm', target: 'package' } },
  { skill: 'project.launch', args: { path: 'D:\\Dev\\App' } },
];
const LABELS = ['Run tests', 'Package', 'Open the result'];

/** Let queued microtasks (a continuation kicked off with `void`) finish. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function setup(world: Partial<World> = {}) {
  const w: World = { processes: [proc('cargo.exe')], downloads: [], online: true, ...world };
  const storage = memoryStorage();
  const clock = { now: Date.parse('2026-09-24T12:00:00Z') };
  const make = (host = fakeHost()) => {
    const manager = new WatchManager({
      storage,
      platform: fakePlatform(w),
      host,
      now: () => clock.now,
      pollMs: 60_000_000, // the test ticks by hand
    });
    return { manager, host };
  };
  return { world: w, storage, clock, make };
}

// ── the happy path ─────────────────────────────────────────────────────────

describe('a watch that fires', () => {
  test('waits, then runs every approved step once, in order, without a card', async () => {
    const { world, make } = setup();
    const { manager, host } = make();
    const w = await manager.create({
      request: 'when the build finishes, run the tests, package it, and open the result',
      condition: { kind: 'process-exits', name: 'cargo.exe', label: 'The build' },
      steps: STEPS,
      stepLabels: LABELS,
      sawProcess: true,
    });

    await manager.tick();
    expect(host.ran).toEqual([]);
    expect(manager.get(w.id)!.status).toBe('active');

    world.processes = [];
    await manager.tick();
    await settle();

    expect(host.ran.map((s) => s.skill)).toEqual(['test.run', 'build.run', 'project.launch']);
    expect(host.approvals).toEqual([true, true, true]);
    const done = manager.get(w.id)!;
    expect(done.status).toBe('done');
    expect(done.stepStates).toEqual(['done', 'done', 'done']);
    expect(host.said.some((s) => /no longer running/.test(s))).toBe(true);
    expect(host.notified.some((n) => /finished/i.test(n))).toBe(true);

    // Nothing runs twice on later ticks.
    await manager.tick();
    await settle();
    expect(host.ran).toHaveLength(3);
  });

  test('a failed step stops the continuation and says why', async () => {
    const { world, make } = setup();
    const { manager, host } = make();
    host.outcome = (step) =>
      step.skill === 'test.run'
        ? { ok: false, outcomes: [{ skill: step.skill, ok: false, error: '3 tests failed.' }] }
        : {};
    const w = await manager.create({
      request: 'r',
      condition: { kind: 'process-exits', name: 'cargo.exe' },
      steps: STEPS,
      stepLabels: LABELS,
    });
    world.processes = [];
    await manager.tick();
    await settle();
    expect(host.ran.map((s) => s.skill)).toEqual(['test.run']);
    const after = manager.get(w.id)!;
    expect(after.status).toBe('failed');
    expect(after.stepStates).toEqual(['failed', 'pending', 'pending']);
    expect(host.said.join('\n')).toMatch(/3 tests failed/);
  });

  test('the approval covers exactly the approved steps and nothing else', async () => {
    const { world, make } = setup();
    const { manager } = make();
    const seen: boolean[] = [];
    const host = fakeHost();
    host.run = async (plan, _io, extra) => {
      seen.push(extra.approvedStep(plan.steps[0]!));
      seen.push(extra.approvedStep({ skill: 'files.delete', args: { path: 'C:\\' } }));
      seen.push(
        extra.approvedStep({
          ...plan.steps[0]!,
          args: { ...plan.steps[0]!.args, path: 'D:\\Other' },
        }),
      );
      return {
        ok: true,
        ran: 1,
        aborted: false,
        outcomes: [{ skill: plan.steps[0]!.skill, ok: true }],
      };
    };
    const m2 = new WatchManager({
      storage: memoryStorage(),
      platform: fakePlatform(world),
      host,
      pollMs: 1e9,
    });
    await m2.create({
      request: 'r',
      condition: { kind: 'process-exits', name: 'cargo.exe' },
      steps: [STEPS[0]!],
      stepLabels: ['t'],
    });
    world.processes = [];
    await m2.tick();
    await settle();
    expect(seen).toEqual([true, false, false]);
    manager.dispose();
  });
});

// ── restarts ───────────────────────────────────────────────────────────────

describe('surviving a restart', () => {
  test('a step that was running when Atlas died is asked about, not repeated', async () => {
    const { world, make } = setup();
    const first = make();
    // Make the second step hang forever, as if the power went out mid-build.
    first.host.outcome = (step) => (step.skill === 'build.run' ? new Promise(() => {}) : {});
    const w = await first.manager.create({
      request: 'r',
      condition: { kind: 'process-exits', name: 'cargo.exe' },
      steps: STEPS,
      stepLabels: LABELS,
    });
    world.processes = [];
    await first.manager.tick();
    await settle();
    expect(first.manager.get(w.id)!.stepStates).toEqual(['done', 'started', 'pending']);
    first.manager.dispose();

    // "Restart": a new manager over the same storage.
    const second = make();
    const note = await second.manager.load();
    await settle();
    const restored = second.manager.get(w.id)!;
    expect(restored.status).toBe('awaiting-approval');
    expect(restored.question?.kind).toBe('uncertain-step');
    expect(restored.question?.step).toBe(1);
    expect(note).toMatch(/can’t tell if “Package” finished/);
    expect(second.host.ran).toEqual([]); // nothing ran on its own

    // "It already happened" → skip ahead to the last step only.
    await second.manager.answer(w.id, 'skip');
    await settle();
    expect(second.host.ran.map((s) => s.skill)).toEqual(['project.launch']);
    expect(second.manager.get(w.id)!.status).toBe('done');
  });

  test('"run it again" re-runs only the uncertain step and what follows', async () => {
    const { world, make } = setup();
    const first = make();
    first.host.outcome = (step) => (step.skill === 'build.run' ? new Promise(() => {}) : {});
    const w = await first.manager.create({
      request: 'r',
      condition: { kind: 'process-exits', name: 'cargo.exe' },
      steps: STEPS,
      stepLabels: LABELS,
    });
    world.processes = [];
    await first.manager.tick();
    await settle();
    first.manager.dispose();

    const second = make();
    await second.manager.load();
    await second.manager.answer(w.id, 'approve');
    await settle();
    expect(second.host.ran.map((s) => s.skill)).toEqual(['build.run', 'project.launch']);
  });

  test('between steps is safe to continue: approved steps resume, and it says so', async () => {
    const { storage, make } = setup();
    const { manager } = make();
    const w = await manager.create({
      request: 'r',
      condition: { kind: 'process-exits', name: 'cargo.exe' },
      steps: STEPS,
      stepLabels: LABELS,
    });
    // Stored mid-run, cleanly between step 1 and step 2.
    const stored = (storage.data.get(WATCHES_KEY) as Watch[]).map((x) =>
      x.id === w.id
        ? {
            ...x,
            status: 'running' as const,
            firedAt: 1,
            stepStates: ['done', 'pending', 'pending'] as Watch['stepStates'],
          }
        : x,
    );
    storage.data.set(WATCHES_KEY, stored);
    manager.dispose();

    const second = make();
    const note = await second.manager.load();
    await settle();
    expect(note).toMatch(/continuing where it left off/);
    expect(second.host.ran.map((s) => s.skill)).toEqual(['build.run', 'project.launch']);
  });

  test('a process that exited while Atlas was closed is an event — ask, don’t act', async () => {
    const { world, make } = setup();
    const first = make();
    const w = await first.manager.create({
      request: 'r',
      condition: { kind: 'process-exits', name: 'cargo.exe' },
      steps: STEPS,
      stepLabels: LABELS,
    });
    first.manager.dispose();

    world.processes = []; // gone by the time Atlas comes back — reboot, or finished?
    const second = make();
    await second.manager.load();
    await second.manager.tick();
    await settle();
    expect(second.host.ran).toEqual([]);
    expect(second.manager.get(w.id)!.question?.kind).toBe('met-while-offline');

    await second.manager.answer(w.id, 'approve');
    await settle();
    expect(second.host.ran).toHaveLength(3);
  });

  test('a finished download is a state — acted on after a restart', async () => {
    const { world, make, clock } = setup({ processes: [] });
    world.downloads = [
      { path: 'x', name: 'Setup.exe.crdownload', ext: 'crdownload', isDirectory: false },
    ];
    const first = make();
    const w = await first.manager.create({
      request: 'r',
      condition: {
        kind: 'downloads-finish',
        folder: 'C:\\Users\\me\\Downloads',
        partials: ['Setup.exe.crdownload'],
      },
      steps: [STEPS[2]!],
      stepLabels: [LABELS[2]!],
    });
    first.manager.dispose();

    world.downloads = [
      {
        path: 'x',
        name: 'Setup.exe',
        ext: 'exe',
        isDirectory: false,
        modifiedAt: clock.now + 1000,
      },
    ];
    const second = make();
    await second.manager.load();
    await second.manager.tick();
    await settle();
    expect(second.host.ran).toHaveLength(1);
    expect(second.manager.get(w.id)!.status).toBe('done');
  });

  test('a record whose steps changed after approval runs nothing', async () => {
    const { storage, make } = setup();
    const { manager } = make();
    const w = await manager.create({
      request: 'r',
      condition: { kind: 'process-exits', name: 'cargo.exe' },
      steps: STEPS,
      stepLabels: LABELS,
    });
    manager.dispose();
    const tampered = (storage.data.get(WATCHES_KEY) as Watch[]).map((x) => ({
      ...x,
      steps: [...x.steps, { skill: 'files.delete', args: { path: 'C:\\Users\\me\\Documents' } }],
      stepStates: [...x.stepStates, 'pending' as const],
    }));
    storage.data.set(WATCHES_KEY, tampered);

    const second = make();
    await second.manager.load();
    expect(second.manager.get(w.id)!.status).toBe('failed');
    await second.manager.tick();
    await settle();
    expect(second.host.ran).toEqual([]);
  });

  test('a watch that expired while Atlas was closed says so and never fires', async () => {
    const { world, make, clock } = setup();
    const first = make();
    const w = await first.manager.create({
      request: 'r',
      condition: { kind: 'process-exits', name: 'cargo.exe' },
      steps: STEPS,
      stepLabels: LABELS,
      ttlMs: 60 * 60_000,
    });
    first.manager.dispose();
    clock.now += 2 * 60 * 60_000;
    world.processes = [];
    const second = make();
    const note = await second.manager.load();
    expect(second.manager.get(w.id)!.status).toBe('expired');
    expect(note).toMatch(/expired while I was closed/);
    await second.manager.tick();
    await settle();
    expect(second.host.ran).toEqual([]);
  });
});

// ── the person's controls ──────────────────────────────────────────────────

describe('controls', () => {
  test('the emergency stop pauses; nothing fires until resumed', async () => {
    const { world, make } = setup();
    const { manager, host } = make();
    const w = await manager.create({
      request: 'r',
      condition: { kind: 'process-exits', name: 'cargo.exe' },
      steps: STEPS,
      stepLabels: LABELS,
    });
    await manager.haltAll();
    world.processes = [];
    await manager.tick();
    await settle();
    expect(host.ran).toEqual([]);
    expect(manager.get(w.id)!.status).toBe('paused');
    await manager.resume(w.id);
    await manager.tick();
    await settle();
    expect(host.ran).toHaveLength(3);
  });

  test('a step cut off by the emergency stop is asked about on resume, not re-run', async () => {
    const { world, make } = setup();
    const { manager, host } = make();
    // The build step is interrupted by the stop: the engine reports the run as halted.
    host.outcome = (step) =>
      step.skill === 'build.run'
        ? {
            ok: false,
            halted: true,
            aborted: true,
            outcomes: [{ skill: step.skill, ok: false, error: 'Halted.' }],
          }
        : {};
    const w = await manager.create({
      request: 'r',
      condition: { kind: 'process-exits', name: 'cargo.exe' },
      steps: STEPS,
      stepLabels: LABELS,
    });
    world.processes = [];
    await manager.tick();
    await settle();
    expect(manager.get(w.id)!.status).toBe('paused');
    expect(manager.get(w.id)!.stepStates).toEqual(['done', 'started', 'pending']);

    host.outcome = undefined;
    await manager.resume(w.id);
    await settle();
    expect(host.ran.map((s) => s.skill)).toEqual(['test.run', 'build.run']); // not run a second time
    expect(manager.get(w.id)!.question).toMatchObject({ kind: 'uncertain-step', step: 1 });
  });

  test('a step the approval did not cover waits for the person, then continues', async () => {
    const { world, make } = setup();
    const { manager, host } = make();
    // The middle step's skill has a preview (a list read at run time), so the
    // executor asks through io.confirm even though the step is approved.
    let asked = 0;
    const original = host.run.bind(host);
    host.run = async (plan, io, extra) => {
      if (plan.steps[0]!.skill === 'build.run') {
        asked++;
        const yes = await io.confirm('Move 12 files?', 'a.txt, b.txt, …');
        if (!yes)
          return {
            ok: false,
            ran: 0,
            aborted: true,
            outcomes: [{ skill: 'build.run', ok: false, skipped: true, error: 'Cancelled.' }],
          };
      }
      return original(plan, io, extra);
    };
    const w = await manager.create({
      request: 'r',
      condition: { kind: 'process-exits', name: 'cargo.exe' },
      steps: STEPS,
      stepLabels: LABELS,
    });
    world.processes = [];
    await manager.tick();
    await settle();
    const waiting = manager.get(w.id)!;
    expect(waiting.status).toBe('awaiting-approval');
    expect(waiting.question).toMatchObject({
      kind: 'uncovered-step',
      step: 1,
      question: 'Move 12 files?',
    });
    expect(host.notified.some((n) => /needs you/.test(n))).toBe(true);
    expect(host.ran.map((s) => s.skill)).toEqual(['test.run']);

    await manager.answer(w.id, 'approve');
    await settle();
    expect(asked).toBe(1);
    expect(host.ran.map((s) => s.skill)).toEqual(['test.run', 'build.run', 'project.launch']);
    expect(manager.get(w.id)!.status).toBe('done');
  });

  test('pause, cancel and delete', async () => {
    const { make } = setup();
    const { manager } = make();
    const a = await manager.create({
      request: 'a',
      condition: { kind: 'online' },
      steps: [],
      stepLabels: [],
    });
    const b = await manager.create({
      request: 'b',
      condition: { kind: 'after', seconds: 600 },
      steps: [],
      stepLabels: [],
    });
    expect(await manager.pause(a.id)).toBe(true);
    expect(manager.get(a.id)!.status).toBe('paused');
    expect(await manager.cancel(b.id)).toBe(true);
    expect(manager.get(b.id)!.status).toBe('cancelled');
    expect(await manager.remove(b.id)).toBe(true);
    expect(manager.get(b.id)).toBeUndefined();
  });
});

// ── conditions ─────────────────────────────────────────────────────────────

describe('conditions', () => {
  const base = { startedAt: 1_000_000 };
  test('a cancelled download fails the watch instead of waiting a day', async () => {
    const platform = fakePlatform({ processes: [], downloads: [], online: true });
    const r = await probeCondition(
      { kind: 'downloads-finish', folder: 'x', partials: ['big.zip.part'] },
      platform,
      base,
      2_000_000,
    );
    expect(r.met).toBe(false);
    expect(r.failed).toMatch(/cancelled/);
  });

  test('only states are trusted across a gap, and a late timer only if barely late', () => {
    expect(reliableAfterGap({ kind: 'process-exits', name: 'x' }, 0)).toBe(false);
    expect(reliableAfterGap({ kind: 'process-starts', name: 'x' }, 0)).toBe(true);
    expect(reliableAfterGap({ kind: 'online' }, 0)).toBe(true);
    expect(reliableAfterGap({ kind: 'after', seconds: 60 }, 60_000)).toBe(true);
    expect(reliableAfterGap({ kind: 'after', seconds: 60 }, 60 * 60_000)).toBe(false);
  });

  test('the fingerprint ignores argument order but not argument values', () => {
    const a = fingerprintSteps([{ skill: 's', args: { x: 1, y: 2 } }]);
    const b = fingerprintSteps([{ skill: 's', args: { y: 2, x: 1 } }]);
    const c = fingerprintSteps([{ skill: 's', args: { x: 1, y: 3 } }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

// ── end to end through the engine ──────────────────────────────────────────

describe('watch.create through the engine', () => {
  function build(world: World) {
    const storage = memoryStorage();
    const platform = {
      ...fakePlatform(world),
      detectProject: async (root: string) => ({
        root,
        systems: ['pnpm'],
        npmScripts: ['build', 'package', 'test'],
        isGitRepo: true,
        cmakeConfigured: false,
      }),
    } as unknown as Platform;
    const skills = new SkillRegistry({
      capabilities: () => ['processes', 'notifications', 'devtools'],
    });
    let engine: Engine | null = null;
    const host = fakeHost();
    const manager = new WatchManager({ storage, platform, host, pollMs: 1e9 });
    skills.registerMany(
      createWatchSkills({
        platform,
        skills,
        manager: () => manager,
        planFor: (t) => engine!.planFor(t),
      }),
    );
    // Stand-ins for the dev skills, with their real ids and params.
    for (const id of ['test.run', 'build.run', 'project.launch']) {
      skills.register({
        id,
        label: id,
        domain: 'build',
        description: id,
        risk: id === 'project.launch' ? 'safe' : 'confirm',
        params: {
          path: { type: 'string', required: true, description: 'p' },
          system: { type: 'string', description: 's' },
          target: { type: 'string', description: 't' },
        },
        run: () => ({ ok: true }),
      });
    }
    const grammar = new Grammar();
    grammar.addMany(createCoreGrammar(new WorkingMemory()));
    grammar.addMany(createExtraGrammar());
    engine = new Engine({ skills, grammar });
    return { engine, manager, host };
  }

  test('the build example: resolves the build, asks for the folder once, shows one card, then waits', async () => {
    const world: World = {
      processes: [proc('cargo.exe'), proc('Discord.exe')],
      downloads: [],
      online: true,
    };
    const { engine, manager } = build(world);
    const cards: string[] = [];
    const questions: string[] = [];
    const outcome = await engine.ask(
      'When this build finishes, run the tests, package it, and open the result.',
      {
        say: () => {},
        confirm: async (q, d) => {
          cards.push(`${q}\n${d}`);
          return true;
        },
        clarify: async (c) => {
          questions.push(c.question);
          return { kind: 'text', text: 'D:\\Dev\\App', many: false };
        },
      },
    );
    expect(outcome.ok).toBe(true);
    expect(questions).toEqual(['Which project folder should those steps run in?']);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatch(/When: The build finishes \(cargo\.exe exits\)/);
    expect(cards[0]).toMatch(/1\. .*test\.run/);
    expect(cards[0]).toMatch(/even if you’re away/);

    const [watch] = manager.live();
    expect(watch!.condition).toEqual({
      kind: 'process-exits',
      name: 'cargo.exe',
      label: 'The build',
    });
    expect(watch!.steps).toEqual([
      { skill: 'test.run', args: { path: 'D:\\Dev\\App', system: 'pnpm' } },
      { skill: 'build.run', args: { path: 'D:\\Dev\\App', system: 'pnpm', target: 'package' } },
      { skill: 'project.launch', args: { path: 'D:\\Dev\\App' } },
    ]);
  });

  test('saying no to the card creates nothing', async () => {
    const world: World = { processes: [proc('cargo.exe')], downloads: [], online: true };
    const { engine, manager } = build(world);
    await engine.ask('when the build finishes, run the tests in D:\\Dev\\App', {
      say: () => {},
      confirm: async () => false,
    });
    expect(manager.list()).toEqual([]);
  });

  test('"let me know when" with nothing after it needs no card at all', async () => {
    const world: World = { processes: [proc('obs64.exe')], downloads: [], online: true };
    const { engine, manager } = build(world);
    let cards = 0;
    const said: string[] = [];
    await engine.ask('let me know when OBS closes', {
      say: (t) => void said.push(t),
      confirm: async () => {
        cards++;
        return true;
      },
    });
    expect(cards).toBe(0);
    expect(manager.live()[0]!.condition).toEqual({
      kind: 'process-exits',
      name: 'obs64.exe',
      label: 'OBS',
    });
    expect(said.join(' ')).toMatch(/Watching until OBS finishes/);
  });

  test('watching something that isn’t running is refused with the fix', async () => {
    const world: World = { processes: [], downloads: [], online: true };
    const { engine, manager } = build(world);
    const said: string[] = [];
    await engine.ask('let me know when OBS closes', {
      say: (t) => void said.push(t),
      confirm: async () => true,
    });
    expect(manager.list()).toEqual([]);
    expect(said.join(' ')).toMatch(/isn’t running.*when OBS starts/);
  });

  test('"watch this download" finds the unfinished one', async () => {
    const world: World = {
      processes: [],
      downloads: [
        { path: 'a', name: 'game-setup.exe.crdownload', ext: 'crdownload', isDirectory: false },
        { path: 'b', name: 'old.zip', ext: 'zip', isDirectory: false },
      ],
      online: true,
    };
    const { engine, manager } = build(world);
    await engine.ask('watch this download', { say: () => {}, confirm: async () => true });
    expect(manager.live()[0]!.condition).toEqual({
      kind: 'downloads-finish',
      folder: 'C:\\Users\\me\\Downloads',
      partials: ['game-setup.exe.crdownload'],
    });
  });

  test('an open-ended agent cannot be a continuation', async () => {
    const world: World = { processes: [proc('cargo.exe')], downloads: [], online: true };
    const { engine, manager } = build(world);
    engine.skills.register({
      id: 'devagent.run',
      label: 'Work on a development task',
      domain: 'devagent',
      description: 'd',
      risk: 'confirm',
      params: {
        goal: { type: 'string', required: true, description: 'g' },
        path: { type: 'string', required: true, description: 'p' },
      },
      run: () => ({ ok: true }),
    });
    const said: string[] = [];
    // A plan the "AI" would produce, reached through planFor via a registered rule.
    engine.grammar.add({
      name: 'fakeAgent',
      order: -100,
      test: (l) =>
        l === 'fix the bugs'
          ? {
              source: 'grammar',
              intent: 'x',
              confidence: 1,
              steps: [{ skill: 'devagent.run', args: { goal: 'fix', path: 'D:\\x' } }],
            }
          : null,
    });
    await engine.ask('when the build finishes, fix the bugs', {
      say: (t) => void said.push(t),
      confirm: async () => true,
    });
    expect(manager.list()).toEqual([]);
    expect(said.join(' ')).toMatch(/can’t run on its own while you’re away/);
  });
});

test('a surface that can draw the question gets the watch itself, not a plain line', async () => {
  const { world, make } = setup();
  const host = fakeHost();
  const asked: Watch[] = [];
  host.needsYou = (w) => void asked.push(structuredClone(w));
  const { manager } = make(host);
  const w = await manager.create({
    request: 'r',
    condition: { kind: 'process-exits', name: 'cargo.exe' },
    steps: STEPS,
    stepLabels: LABELS,
  });
  manager.dispose();
  world.processes = [];
  const second = make(host);
  await second.manager.load();
  await second.manager.tick();
  await settle();
  expect(asked.map((x) => [x.id, x.question?.kind])).toEqual([[w.id, 'met-while-offline']]);
  expect(host.said.some((s) => /A watch needs you/.test(s))).toBe(false);
  expect(host.notified.some((n) => /needs you/.test(n))).toBe(true);
});
