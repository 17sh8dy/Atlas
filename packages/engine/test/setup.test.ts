/**
 * Setups — "get my PC ready for recording" — act, verify, report what was
 * verified. Driven through the real Engine, grammar and executor against a
 * fake machine whose processes, windows, audio devices and disks the test
 * controls, so "OBS is running" in a report is only ever true when the fake
 * process list says it is.
 */

import { describe, expect, test } from 'vitest';
import type {
  ClarifyAnswer,
  Clarification,
  Platform,
  ProcessEntry,
  Storage,
  WindowEntry,
} from '@atlas/core';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { SkillRegistry } from '../src/skills/registry';
import { createSetupSkills } from '../src/skills/setup-skills';
import { createWindowSkills, placementBounds } from '../src/skills/window-skills';
import { SetupStore } from '../src/setup/store';
import { reportFor } from '../src/setup/runner';
import { Executor } from '../src/planner/executor';

function memoryStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
}

const DISPLAY = {
  name: 'D1',
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  workX: 0,
  workY: 0,
  workWidth: 1920,
  workHeight: 1040,
  primary: true,
};

interface Machine {
  processes: ProcessEntry[];
  windows: WindowEntry[];
  mic: string | null;
  freeGb: Record<string, number>;
  /** What `app.open` starts, by the name asked for. */
  launches: Record<string, { process: string; title: string } | null>;
  closed: string[];
}

function win(
  id: string,
  processName: string,
  title: string,
  extra: Partial<WindowEntry> = {},
): WindowEntry {
  return {
    id,
    title,
    className: 'C',
    processName,
    pid: 1,
    x: 700,
    y: 300,
    width: 800,
    height: 600,
    minimized: false,
    maximized: false,
    active: false,
    ...extra,
  } as WindowEntry;
}

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    processes: [{ pid: 1, name: 'explorer.exe' }],
    windows: [],
    mic: 'Shure MV7+',
    freeGb: { 'C:': 120, 'D:': 347 },
    launches: {
      OBS: { process: 'obs64.exe', title: 'OBS 30.2.3 - Profile: Untitled - Scenes: Untitled' },
      Discord: { process: 'Discord.exe', title: 'Discord' },
      Fortnite: { process: 'FortniteClient-Win64-Shipping.exe', title: 'Fortnite' },
    },
    closed: [],
    ...overrides,
  };
}

function platformFor(m: Machine): Platform {
  let nextId = 50;
  return {
    capabilities: async () => [],
    runningProcesses: async () => m.processes,
    listWindows: async () => m.windows,
    listDisplays: async () => [DISPLAY],
    audioDevices: async () => ({ input: m.mic, output: 'Speakers' }),
    systemInfo: async () => ({
      cpuPercent: 1,
      memoryUsedBytes: 1,
      memoryTotalBytes: 2,
      uptimeSeconds: 1,
      disks: Object.entries(m.freeGb).map(([mount, free]) => ({
        mount: `${mount}\\`,
        totalBytes: 1000 * 1024 ** 3,
        usedBytes: (1000 - free) * 1024 ** 3,
      })),
    }),
    networkReachable: async () => true,
    closeWindow: async (id: string) => {
      const w = m.windows.find((x) => x.id === id);
      if (!w) return false;
      m.closed.push(w.processName);
      m.windows = m.windows.filter((x) => x.id !== id);
      if (!m.windows.some((x) => x.processName === w.processName)) {
        m.processes = m.processes.filter((p) => p.name !== w.processName);
      }
      return true;
    },
    setWindowBounds: async (
      id: string,
      b: { x: number; y: number; width: number; height: number },
    ) => {
      m.windows = m.windows.map((w) => (w.id === id ? { ...w, ...b } : w));
      return true;
    },
    restoreWindow: async () => true,
    maximizeWindow: async () => true,
    _launch(name: string) {
      const l = m.launches[name];
      if (!l) return false;
      m.processes.push({ pid: nextId, name: l.process });
      m.windows.push(win(`w${nextId++}`, l.process, l.title));
      return true;
    },
  } as unknown as Platform;
}

function build(m: Machine, storage: Storage = memoryStorage()) {
  const platform = platformFor(m);
  const skills = new SkillRegistry({
    capabilities: () => ['apps', 'processes', 'window-control', 'screen', 'audio-devices'],
  });
  // app.open stand-in: launches from the fake machine's table.
  skills.register({
    id: 'app.open',
    label: 'Open an app',
    domain: 'apps',
    description: 'open',
    risk: 'safe',
    params: { name: { type: 'string', required: true, description: 'app' } },
    run: (args) =>
      (platform as unknown as { _launch(n: string): boolean })._launch(String(args.name))
        ? { ok: true, message: `Opening ${args.name}` }
        : { ok: false, error: `I couldn’t find ${args.name}.` },
  });
  skills.registerMany(createWindowSkills(platform).filter((s) => s.id === 'window.place'));
  const store = new SetupStore(storage);
  skills.registerMany(
    createSetupSkills({
      platform,
      skills,
      store,
      getExecutionMode: () => 'doIt',
      runner: {
        sleep: async () => {},
        openTimeoutMs: 3,
        pollMs: 1,
        closeTimeoutMs: 3,
        placeTimeoutMs: 3,
      },
    }),
  );
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(new WorkingMemory()));
  grammar.addMany(createExtraGrammar());
  return { engine: new Engine({ skills, grammar }), store, platform };
}

function io(answers: ClarifyAnswer[] = [], approve = true) {
  const said: string[] = [];
  const cards: string[] = [];
  const questions: Clarification[] = [];
  return {
    said,
    cards,
    questions,
    io: {
      say: (t: string) => void said.push(t),
      // The checklist card, flattened: title, subtitle, then "✅ line" per check.
      showResults: (rows: ResultRow[], meta?: { title?: string; subtitle?: string }) =>
        void said.push(
          [meta?.title, meta?.subtitle, ...rows.map((r) => `${r.icon} ${r.title}`)].join('\n'),
        ),
      confirm: async (q: string, d?: string) => {
        cards.push(`${q}\n${d ?? ''}`);
        return approve;
      },
      clarify: async (c: Clarification) => {
        questions.push(c);
        return answers.shift() ?? { kind: 'cancelled' as const };
      },
    },
  };
}

describe('get my PC ready for recording', () => {
  test('first time: asks what it means (offering the real mic and drives), saves, runs, verifies', async () => {
    const m = machine({
      processes: [
        { pid: 1, name: 'explorer.exe' },
        { pid: 2, name: 'chrome.exe' },
      ],
      windows: [
        win('c1', 'chrome.exe', 'YouTube - Google Chrome'),
        win('c2', 'chrome.exe', 'Gmail - Google Chrome'),
      ],
    });
    const { engine, store } = build(m);
    const t = io([
      { kind: 'text', text: 'OBS, Discord and Fortnite', many: true },
      { kind: 'text', text: 'Chrome', many: true },
      { kind: 'choice', id: 'expect' },
      { kind: 'choice', id: 'd:D:' },
      { kind: 'text', text: 'Discord on the left', many: false },
    ]);

    const outcome = await engine.ask('Atlas, get my PC ready for recording', t.io);
    expect(outcome.ok).toBe(true);

    // The questions offered what is really there.
    expect(t.questions.map((q) => q.question)).toEqual([
      'What should be open when you’re ready for recording?',
      'Anything I should close first?',
      'Should I check your microphone?',
      'Make sure there’s room for recording? I’ll check for at least 20 GB free.',
      'Put any windows somewhere in particular?',
    ]);
    expect(t.questions[2]!.choices[0]!.label).toBe('Yes — it should be Shure MV7+');
    expect(t.questions[3]!.choices.map((c) => c.label)).toContain('On D: — 347 GB free now');

    // One card, with the whole plan on it.
    expect(t.cards).toHaveLength(1);
    expect(t.cards[0]).toMatch(/Save and run your recording setup\?/);
    expect(t.cards[0]).toMatch(/Close: Chrome \(2 windows\)/);
    expect(t.cards[0]).toMatch(/Open: OBS, Discord, Fortnite/);

    // It did it, and the report is built from what it then read.
    expect(m.closed).toEqual(['chrome.exe', 'chrome.exe']);
    expect(m.processes.map((p) => p.name)).toEqual(
      expect.arrayContaining(['obs64.exe', 'Discord.exe', 'FortniteClient-Win64-Shipping.exe']),
    );
    const discord = m.windows.find((w) => w.processName === 'Discord.exe')!;
    expect(discord).toMatchObject(placementBounds('left', DISPLAY));
    const report = t.said.join('\n');
    expect(report).toBe(
      [
        'Recording setup complete',
        'Saved — say “get ready for recording” next time, or change it in Settings → Setups.',
        '✅ Chrome is closed',
        '✅ OBS is running',
        '✅ Discord is running',
        '✅ Fortnite is running',
        '✅ Discord is on the left',
        '✅ Shure MV7+ is your microphone',
        '✅ 347 GB free on D:',
      ].join('\n'),
    );
    // What is stored (and what a surface without cards is told) is still one sentence.
    expect(store.get('recording')!.lastReport).toMatch(
      /^Recording setup complete\. Chrome is closed, OBS is running, .*, and 347 GB free on D:\.$/,
    );

    // Saved.
    expect(store.get('recording')!.items).toHaveLength(7);
  });

  test('second time: nothing to close means no card at all — it just does it and reports', async () => {
    const storage = memoryStorage();
    const m = machine();
    const first = build(m, storage);
    await first.store.save('recording', [
      { kind: 'open', app: 'OBS' },
      { kind: 'mic', expect: 'MV7' },
      { kind: 'storage', drive: 'D:', minGb: 50 },
    ]);
    const { engine } = build(m, storage);
    const t = io();
    await engine.ask('get ready to record', t.io);
    expect(t.cards).toEqual([]);
    expect(t.questions).toEqual([]);
    expect(t.said.join('\n')).toMatch(
      /Recording setup complete\n.*\n✅ OBS is running\n✅ Shure MV7\+ is your microphone\n✅ 347 GB free on D:$/,
    );
  });

  test('the report says what did not work, and does not claim it did', async () => {
    const storage = memoryStorage();
    const m = machine({ mic: 'SteelSeries Sonar - Microphone', freeGb: { 'C:': 120, 'D:': 12 } });
    m.launches.Fortnite = { process: 'EpicGamesLauncher.exe', title: 'Epic Games Launcher' }; // the game itself never starts
    const first = build(m, storage);
    await first.store.save('recording', [
      { kind: 'open', app: 'OBS' },
      { kind: 'open', app: 'Fortnite' },
      { kind: 'mic', expect: 'MV7' },
      { kind: 'storage', drive: 'D:', minGb: 50 },
    ]);
    const { engine } = build(m, storage);
    const t = io();
    await engine.ask('run my recording setup', t.io);
    const report = t.said.join('\n');
    expect(report).toMatch(/^Recording setup: 1 of 4 ready$/m);
    expect(report).toMatch(/^✅ OBS is running$/m);
    expect(report).toMatch(/^⚠️ Fortnite didn’t start within 0 seconds$/m);
    expect(report).toMatch(/^⚠️ Your microphone is SteelSeries Sonar - Microphone, not MV7/m);
    expect(report).toMatch(/^⚠️ Only 12 GB free on D: \(you wanted at least 50\)$/m);
  });

  test('a known setup that will close something shows the card, and a no changes nothing', async () => {
    const storage = memoryStorage();
    const m = machine({
      processes: [{ pid: 2, name: 'Steam.exe' }],
      windows: [win('s1', 'Steam.exe', 'Steam')],
    });
    const first = build(m, storage);
    await first.store.save('work', [
      { kind: 'close', app: 'Steam' },
      { kind: 'open', app: 'Discord' },
    ]);
    const { engine } = build(m, storage);
    const t = io([], false);
    await engine.ask('get my pc ready for work', t.io);
    expect(t.cards[0]).toMatch(/Get ready for work\?/);
    expect(t.cards[0]).toMatch(/Close: Steam/);
    expect(m.closed).toEqual([]);
    expect(m.processes.map((p) => p.name)).toEqual(['Steam.exe']);
  });

  test('"get my PC ready" with no name asks "ready for what?", offering what is saved', async () => {
    const storage = memoryStorage();
    const m = machine();
    const first = build(m, storage);
    await first.store.save('streaming', [{ kind: 'open', app: 'OBS' }]);
    const { engine, store } = build(m, storage);
    await store.load(); // the app loads it at startup
    const t = io([{ kind: 'cancelled' }]);
    await engine.ask('get my pc ready', t.io);
    expect(t.questions[0]!.question).toMatch(/Ready for what\?/);
    expect(t.questions[0]!.choices.map((c) => c.label)).toContain('Streaming');
  });

  test('inline specs skip the questions; anything unreadable is said back, not guessed', async () => {
    const m = machine();
    const { engine, store } = build(m);
    const t = io();
    await engine.ask('get my pc ready for streaming: open OBS, make me a sandwich', t.io);
    expect(t.questions).toEqual([]);
    expect(t.said.join(' ')).toMatch(/didn’t understand “make me a sandwich”/);
    expect(store.all()).toEqual([]);
  });

  test('if something opens between the card and the yes, it stops rather than close an unlisted app', async () => {
    const storage = memoryStorage();
    const m = machine({
      processes: [{ pid: 2, name: 'Steam.exe' }],
      windows: [win('s1', 'Steam.exe', 'Steam')],
    });
    const first = build(m, storage);
    await first.store.save('work', [
      { kind: 'close', app: 'Steam' },
      { kind: 'close', app: 'Chrome' },
    ]);
    const { engine } = build(m, storage);
    const t = io();
    t.io.confirm = async (q: string, d?: string) => {
      t.cards.push(`${q}\n${d}`);
      // Chrome starts while the card is up.
      m.processes.push({ pid: 9, name: 'chrome.exe' });
      m.windows.push(win('c9', 'chrome.exe', 'Chrome'));
      return true;
    };
    await engine.ask('get ready for work', t.io);
    expect(m.closed).toEqual([]);
    expect(t.said.join(' ')).toMatch(/Something changed since I looked/);
  });
});

describe('the executor’s earlier-approval hook', () => {
  test('approvedStep skips the card for that exact step only, and never for a preview', async () => {
    const skills = new SkillRegistry();
    let ran = 0;
    skills.register({
      id: 'x.write',
      label: 'Write',
      domain: 'x',
      description: 'w',
      risk: 'confirm',
      params: { v: { type: 'string', description: 'v' } },
      run: () => ({ ok: !!++ran }),
    });
    skills.register({
      id: 'x.bulk',
      label: 'Bulk',
      domain: 'x',
      description: 'b',
      risk: 'confirm',
      preview: async () => ({ kind: 'ask', detail: 'a, b, c' }),
      run: () => ({ ok: !!++ran }),
    });
    const ex = new Executor(skills);
    const asked: string[] = [];
    const ctx = {
      say: () => {},
      confirm: async (q: string) => {
        asked.push(q);
        return true;
      },
    };
    const approved = { skill: 'x.write', args: { v: '1' } };
    await ex.run(
      { source: 'routine', intent: 'i', confidence: 1, steps: [approved] },
      ctx as never,
      {
        approvedStep: (s) => s.skill === approved.skill && s.args.v === '1',
      },
    );
    expect(asked).toEqual([]);
    await ex.run(
      {
        source: 'routine',
        intent: 'i',
        confidence: 1,
        steps: [{ skill: 'x.write', args: { v: '2' } }],
      },
      ctx as never,
      {
        approvedStep: (s) => s.skill === approved.skill && s.args.v === '1',
      },
    );
    expect(asked).toHaveLength(1);
    await ex.run(
      { source: 'routine', intent: 'i', confidence: 1, steps: [{ skill: 'x.bulk', args: {} }] },
      ctx as never,
      {
        approvedStep: () => true,
      },
    );
    expect(asked).toHaveLength(2);
  });
});

test('reportFor reads like a sentence', () => {
  const setup = { name: 'recording', items: [], createdAt: 0, updatedAt: 0 };
  expect(
    reportFor(setup, [
      { item: { kind: 'open', app: 'OBS' }, ok: true, observed: 'OBS is running' },
      { item: { kind: 'mic' }, ok: true, observed: 'MV7+ is your microphone' },
      {
        item: { kind: 'storage', drive: 'D:', minGb: 20 },
        ok: true,
        observed: '347 GB free on D:',
      },
    ]),
  ).toBe(
    'Recording setup complete. OBS is running, MV7+ is your microphone, and 347 GB free on D:.',
  );
});
