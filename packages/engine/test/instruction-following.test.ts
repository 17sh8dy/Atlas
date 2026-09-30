/**
 * What someone says is what gets done — and Atlas does not ask again for what
 * it was already told.
 *
 * The bug: "Open Notepad++ then create a new note then type 'Test'" answered
 * "what should the note say?". "Create a new note" was read as a note in
 * Atlas's own notebook, which needs text, while the text sat in the next
 * clause. The same family: an unquoted "open notepad and type hello" was one
 * app called "notepad and type hello", so what to type was lost outright; and
 * nothing waited for the app before typing, so the keys could go anywhere.
 *
 * Checked in three layers: how the sentence is understood (the grammar), what
 * is asked (the real Executor), and what is sent and where (a fake machine).
 */

import { assert, test } from 'vitest';
import type { Plan, Platform, Skill, SkillContext, WindowEntry } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { Executor } from '../src/planner/executor';
import { SkillRegistry } from '../src/skills/registry';
import { createWindowSkills } from '../src/skills/window-skills';
import { createInputSkills } from '../src/skills/input-skills';

function grammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}

const steps = (text: string) =>
  grammar()
    .parse(text)
    ?.steps.map((s) => [s.skill, s.args]);

// ---- how it is understood -------------------------------------------------------

test('the reported sentence becomes open, wait, new document, type — with no note asked for', () => {
  assert.deepEqual(steps("Open Notepad++ then create a new note then type 'Test'"), [
    ['app.open', { name: 'Notepad++' }],
    ['window.await', { window: 'Notepad++' }],
    ['input.hotkey', { combo: 'ctrl+n' }],
    ['input.typeText', { text: 'Test' }],
  ]);
});

test('"create a new note" on its own is still a note in Atlas', () => {
  assert.equal(grammar().parse('create a new note')?.steps[0]?.skill, 'notes.add');
});

test('quoted text arrives exactly as written: case, punctuation, and words that look like connectors', () => {
  const cases: Array<[string, string]> = [
    [`open notepad then type 'Hello, World'`, 'Hello, World'],
    [`open notepad then type "salt and pepper"`, 'salt and pepper'],
    [`open notepad then type 'first this, then that'`, 'first this, then that'],
    [`open notepad then type “Curly Quotes”`, 'Curly Quotes'],
    [`open notepad then type 'MiXeD CaSe 123!'`, 'MiXeD CaSe 123!'],
  ];
  for (const [sentence, expected] of cases) {
    const typed = steps(sentence)?.find(([skill]) => skill === 'input.typeText');
    assert.deepEqual(typed, ['input.typeText', { text: expected }], sentence);
  }
});

test('unquoted text after an opened app is typed, in the case it was written', () => {
  assert.deepEqual(steps('open notepad and type Hello There'), [
    ['app.open', { name: 'notepad' }],
    ['window.await', { window: 'notepad' }],
    ['input.typeText', { text: 'Hello There' }],
  ]);
});

test('an apostrophe inside the text is not a quotation mark', () => {
  const typed = steps("open notepad then type it's fine")?.find(([s]) => s === 'input.typeText');
  assert.deepEqual(typed, ['input.typeText', { text: "it's fine" }]);
});

test('unquoted "type …" on its own is not guessed at — nothing says where it would go', () => {
  const plan = grammar().parse('type hello');
  assert.notEqual(plan?.steps[0]?.skill, 'input.typeText');
});

test('arguments survive a longer chain: each typed text lands in its own step', () => {
  const s = steps("open notepad then type 'one' then press enter then type 'two'");
  const typed = s?.filter(([skill]) => skill === 'input.typeText').map(([, a]) => a);
  assert.deepEqual(typed, [{ text: 'one' }, { text: 'two' }]);
  assert.deepEqual(
    s?.map(([skill]) => skill),
    ['app.open', 'window.await', 'input.typeText', 'input.pressKey', 'input.typeText'],
  );
});

test('an app that is not acted in afterwards gets no waiting step', () => {
  const plan = grammar().parse('open notepad');
  assert.deepEqual(
    plan?.steps.map((x) => x.skill),
    ['app.open'],
  );
});

// ---- what is asked --------------------------------------------------------------

function fakeMachine(windows: () => WindowEntry[]) {
  const sent: string[] = [];
  let front = '';
  const platform = {
    capabilities: async () => ['input', 'window-control', 'windows'],
    listWindows: async () => windows(),
    activeWindow: async () => windows().find((w) => w.id === front) ?? null,
    focusWindow: async (id: string) => {
      front = id;
      return true;
    },
    typeText: async (t: string) => {
      sent.push(`type:${t}`);
      return true;
    },
    hotkey: async (mods: string[], k: string) => {
      sent.push(`hotkey:${[...mods, k].join('+')}`);
      return true;
    },
    pressKey: async (k: string) => {
      sent.push(`key:${k}`);
      return true;
    },
  } as unknown as Platform;
  return { platform, sent };
}

const NOTEPAD: WindowEntry = {
  id: 'n1',
  title: 'new 1 - Notepad++',
  className: 'x',
  processName: 'notepad++.exe',
  pid: 9,
  x: 0,
  y: 0,
  width: 500,
  height: 400,
  minimized: false,
  maximized: false,
  active: false,
};

function launcher(log: string[]): Skill {
  return {
    id: 'app.open',
    label: 'Open an app',
    domain: 'apps',
    description: 'launch',
    risk: 'safe',
    params: { name: { type: 'string', required: true, description: 'app' } },
    run: async (args) => {
      log.push(`open:${String(args.name)}`);
      return { ok: true, message: `Opening ${String(args.name)}.` };
    },
  };
}

async function execute(plan: Plan, platform: Platform, extra: Skill[] = []) {
  const registry = new SkillRegistry({
    capabilities: () => ['input', 'window-control', 'windows'],
  });
  registry.registerMany([
    ...createWindowSkills(platform),
    ...createInputSkills(platform),
    ...extra,
  ]);
  const asked: string[] = [];
  const said: string[] = [];
  const ctx: SkillContext = {
    say: (t) => said.push(t),
    confirm: async (q) => {
      asked.push(q);
      return true;
    },
    clarify: async (q) => {
      asked.push(q.question);
      return { kind: 'cancelled' };
    },
  };
  const outcome = await new Executor(registry).run(plan, ctx, {});
  return { outcome, asked, said };
}

test('the reported sentence runs end to end without asking anything', async () => {
  const log: string[] = [];
  const m = fakeMachine(() => [NOTEPAD]);
  const plan = grammar().parse("Open Notepad++ then create a new note then type 'Test'")!;
  const { outcome, asked, said } = await execute(plan, m.platform, [launcher(log)]);

  assert.deepEqual(asked, [], 'nothing was asked — everything needed was already said');
  assert.isTrue(outcome.ok);
  assert.deepEqual(log, ['open:Notepad++']);
  // In order, exactly what was written, nothing added or dropped.
  assert.deepEqual(m.sent, ['hotkey:ctrl+n', 'type:Test']);
  // And it reports where the text went, read back after the fact.
  assert.match(said.join(' '), /Typed “Test” — in front: “new 1 - Notepad\+\+”/);
});

test('if the app never shows a window, nothing is typed anywhere', async () => {
  const log: string[] = [];
  const m = fakeMachine(() => []);
  const plan: Plan = {
    source: 'grammar',
    intent: 't',
    confidence: 1,
    steps: [
      { skill: 'app.open', args: { name: 'Notepad++' } },
      { skill: 'window.await', args: { window: 'Notepad++', seconds: 1 } },
      { skill: 'input.typeText', args: { text: 'Test' } },
    ],
  };
  const { outcome, said } = await execute(plan, m.platform, [launcher(log)]);
  assert.isFalse(outcome.ok);
  assert.deepEqual(m.sent, [], 'no keystrokes went to an unknown window');
  assert.match(said.join(' '), /never saw its window/);
});

test('genuinely missing information is still asked for — once, about the missing part', async () => {
  const note: Skill = {
    id: 'notes.add',
    label: 'Add a note',
    domain: 'notes',
    description: 'note',
    risk: 'safe',
    params: { text: { type: 'string', required: true, description: 'what the note says' } },
    run: async () => ({ ok: true, message: 'Saved.' }),
  };
  const m = fakeMachine(() => []);
  const missing = await execute(
    { source: 'grammar', intent: 't', confidence: 1, steps: [{ skill: 'notes.add', args: {} }] },
    m.platform,
    [note],
  );
  assert.equal(missing.asked.length, 1, 'asked once');

  const given = await execute(
    {
      source: 'grammar',
      intent: 't',
      confidence: 1,
      steps: [{ skill: 'notes.add', args: { text: 'buy milk' } }],
    },
    m.platform,
    [note],
  );
  assert.deepEqual(given.asked, [], 'and never when it was supplied');
});

test('quoted text that contains another command is still just text', () => {
  const s = steps(`open notepad then type 'hello and open chrome'`)!;
  assert.deepEqual(
    s.map(([skill]) => skill),
    ['app.open', 'window.await', 'input.typeText'],
    'no second app was opened out of the middle of the sentence',
  );
  assert.deepEqual(s[2], ['input.typeText', { text: 'hello and open chrome' }]);
});
