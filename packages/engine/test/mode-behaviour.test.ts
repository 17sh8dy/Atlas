/**
 * The three execution modes, and the rule that a button is judged by what it
 * would do — not by what it is called.
 *
 * Everything here goes through the real `Executor` and the real `uia.invoke`
 * skill; only the machine underneath is faked. The point is the behaviour a
 * person sees: which cards appear, which actions run, in which mode.
 *
 *  Do It?           routine actions run; consequential ones ask.
 *  Plan First       one card for the plan; runs exactly that plan.
 *  Confirm Actions  every consequential action asks, on its own; a plan never
 *                   stands in for it.
 *
 * And in all three, a button whose real effect is a payment (or a send, or a
 * delete…) asks — including a "Continue" that is only a payment because of the
 * page it is on, and a control Atlas cannot make sense of.
 */

import { assert, test } from 'vitest';
import type {
  ExecutionMode,
  Plan,
  Platform,
  Skill,
  SkillContext,
  UiaNode,
  WindowEntry,
} from '@atlas/core';
import { Executor } from '../src/planner/executor';
import { SkillRegistry } from '../src/skills/registry';
import { createUiaSkills } from '../src/skills/uia-skills';
import { assessControl } from '../src/safety/ui-consequence';

// ---- a tiny UI tree builder --------------------------------------------------

interface Spec {
  role: string;
  name: string;
  children?: Spec[];
}

function build(spec: Spec, path: number[] = []): UiaNode {
  return {
    path,
    role: spec.role,
    name: spec.name,
    automationId: '',
    enabled: true,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    children: (spec.children ?? []).map((child, i) => build(child, [...path, i])),
  };
}

const button = (name: string): Spec => ({ role: 'button', name });
const text = (name: string): Spec => ({ role: 'text', name });

function windowOf(title: string): WindowEntry {
  return {
    id: 'w1',
    title,
    className: 'x',
    processName: 'app.exe',
    pid: 1,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    minimized: false,
    maximized: false,
    active: true,
  };
}

/** A machine with one window, showing `body`. Records what got pressed. */
function machine(title: string, body: Spec[]) {
  const pressed: number[][] = [];
  const tree = build({ role: 'window', name: title, children: body });
  const platform = {
    capabilities: async () => ['ui-automation', 'window-control'],
    listWindows: async () => [windowOf(title)],
    uiaTree: async () => tree,
    uiaInvoke: async (_id: string, path: number[]) => {
      pressed.push(path);
      return true;
    },
  } as unknown as Platform;
  return { platform, pressed, tree };
}

// ---- a harness around the real executor --------------------------------------

function fileSkill(id: string, log: string[]): Skill {
  return {
    id,
    label: id,
    domain: 'files',
    description: `does ${id}`,
    risk: 'confirm',
    params: { n: { type: 'number', description: 'which one' } },
    run: async (args) => {
      log.push(`${id}:${String(args.n ?? '')}`);
      return { ok: true, message: 'done' };
    },
  };
}

function run(
  steps: Array<{ skill: string; args: Record<string, string | number | boolean> }>,
  opts: {
    mode: ExecutionMode;
    skills: Skill[];
    /** Answers to each card in order; repeats the last one. */
    answers?: boolean[];
    isPreapproved?: () => Promise<boolean>;
  },
) {
  const registry = new SkillRegistry({ capabilities: () => ['ui-automation', 'window-control'] });
  registry.registerMany(opts.skills);
  const cards: string[] = [];
  const answers = opts.answers ?? [true];
  const ctx: SkillContext = {
    say: () => {},
    showResults: () => {},
    confirm: async (question) => {
      cards.push(question);
      return answers[Math.min(cards.length - 1, answers.length - 1)]!;
    },
  };
  const plan: Plan = { source: 'grammar', intent: 'test', confidence: 1, steps };
  return new Executor(registry)
    .run(plan, ctx, { mode: opts.mode, isPreapproved: opts.isPreapproved })
    .then((outcome) => ({ outcome, cards }));
}

const MODES: ExecutionMode[] = ['doIt', 'planFirst', 'confirmActions'];

// ---- what a button would do ---------------------------------------------------

function verdict(title: string, body: Spec[], target: string) {
  const { tree } = machine(title, body);
  const find = (n: UiaNode): UiaNode | null =>
    n.name === target ? n : (n.children.map(find).find(Boolean) ?? null);
  const node = find(tree)!;
  assert.isNotNull(node, `no control called ${target}`);
  return assessControl({ root: tree, node, windowTitle: title });
}

test('"Continue" on a checkout page is a payment, and asks', () => {
  const v = verdict(
    'Checkout — Contoso',
    [text('Order total $54.00'), button('Continue')],
    'Continue',
  );
  assert.equal(v.kind, 'ask');
});

test('"Continue" on a cookie banner is just a button, and does not', () => {
  const v = verdict(
    'Cookie preferences',
    [text('We use cookies to improve your experience.'), button('Continue')],
    'Continue',
  );
  assert.equal(v.kind, 'routine');
});

test('"Continue" in a window that shows no text asks — not knowing is not permission', () => {
  const v = verdict('Setup', [button('Continue')], 'Continue');
  assert.equal(v.kind, 'ask');
});

test('a control with no name asks', () => {
  const v = verdict('Some app', [text('Hello there'), button('')], '');
  assert.equal(v.kind, 'ask');
});

test('a control that names a consequential thing asks, wherever it is', () => {
  for (const label of [
    'Pay $12.00',
    'Buy now',
    'Place order',
    'Subscribe',
    'Delete',
    'Send',
    'Install',
  ]) {
    const v = verdict('Any window', [text('Something'), button(label)], label);
    assert.equal(v.kind, 'ask', label);
  }
});

test('ordinary controls do not ask', () => {
  for (const label of [
    'File',
    'Play',
    'Search',
    'Format',
    'Border color',
    'Tip of the day',
    'Messages',
  ]) {
    const v = verdict('Notepad', [text('Untitled'), button(label)], label);
    assert.equal(v.kind, 'routine', label);
  }
});

test('a control inside a "Delete account" dialog is part of that prompt', () => {
  const v = verdict(
    'Settings',
    [
      {
        role: 'dialog',
        name: 'Delete account?',
        children: [text('This cannot be undone.'), button('Yes')],
      },
    ],
    'Yes',
  );
  assert.equal(v.kind, 'ask');
});

test('the reason names the actual words, so the card can say why', () => {
  const v = verdict('Checkout', [text('Order total $54.00'), button('Continue')], 'Continue');
  assert.equal(v.kind, 'ask');
  // It quotes the words that gave it away, not a generic warning.
  if (v.kind === 'ask') assert.match(v.reason, /checkout|order total/i);
});

// ---- through the executor, in every mode --------------------------------------

test('a payment button asks in every mode, and nothing is pressed until you say yes', async () => {
  for (const mode of MODES) {
    const m = machine('Checkout — Contoso', [text('Order total $54.00'), button('Continue')]);
    const { outcome, cards } = await run([{ skill: 'uia.invoke', args: { control: 'continue' } }], {
      mode,
      skills: createUiaSkills(m.platform),
      answers: [false],
    });
    assert.equal(cards.length, 1, `${mode}: one card`);
    assert.match(cards[0]!, /Continue/, mode);
    assert.deepEqual(m.pressed, [], `${mode}: declined, so not pressed`);
    assert.isFalse(outcome.ok, mode);
  }
});

test('the same button presses once you approve', async () => {
  for (const mode of MODES) {
    const m = machine('Checkout — Contoso', [text('Order total $54.00'), button('Continue')]);
    const { cards } = await run([{ skill: 'uia.invoke', args: { control: 'continue' } }], {
      mode,
      skills: createUiaSkills(m.platform),
      answers: [true],
    });
    assert.equal(cards.length, 1, mode);
    assert.equal(m.pressed.length, 1, mode);
  }
});

test('a harmless button runs with no card in every mode', async () => {
  for (const mode of MODES) {
    const m = machine('Notepad', [text('Untitled'), button('File')]);
    const { cards } = await run([{ skill: 'uia.invoke', args: { control: 'file' } }], {
      mode,
      skills: createUiaSkills(m.platform),
    });
    assert.deepEqual(cards, [], mode);
    assert.equal(m.pressed.length, 1, mode);
  }
});

test('Plan First does not let its plan approval cover a button it could not see', async () => {
  // The plan has a consequential file step (so there IS a plan card) and a
  // payment button. Approving the plan approved "activate a control" in the
  // abstract; it did not approve this one.
  const log: string[] = [];
  const m = machine('Checkout', [text('Order total $54.00'), button('Continue')]);
  const { cards } = await run(
    [
      { skill: 'files.create', args: { n: 1 } },
      { skill: 'uia.invoke', args: { control: 'continue' } },
    ],
    {
      mode: 'planFirst',
      skills: [...createUiaSkills(m.platform), fileSkill('files.create', log)],
      answers: [true, false],
    },
  );
  assert.equal(cards.length, 2, 'the plan card, then the button');
  assert.deepEqual(log, ['files.create:1']);
  assert.deepEqual(m.pressed, []);
});

// ---- the three modes, side by side -------------------------------------------

test('Do It?: an action already covered by an Allowed Folder runs without asking', async () => {
  const log: string[] = [];
  const { cards } = await run([{ skill: 'files.create', args: { n: 1 } }], {
    mode: 'doIt',
    skills: [fileSkill('files.create', log)],
    isPreapproved: async () => true,
  });
  assert.deepEqual(cards, []);
  assert.deepEqual(log, ['files.create:1']);
});

test('Do It?: a consequential action outside that still asks', async () => {
  const log: string[] = [];
  const { cards } = await run([{ skill: 'files.delete', args: { n: 1 } }], {
    mode: 'doIt',
    skills: [fileSkill('files.delete', log)],
    isPreapproved: async () => false,
  });
  assert.equal(cards.length, 1);
});

test('Confirm Actions: every consequential action asks on its own, even one Do It? would run', async () => {
  const log: string[] = [];
  const { cards } = await run(
    [
      { skill: 'files.create', args: { n: 1 } },
      { skill: 'files.create', args: { n: 2 } },
      { skill: 'files.create', args: { n: 3 } },
    ],
    {
      mode: 'confirmActions',
      skills: [fileSkill('files.create', log)],
      isPreapproved: async () => true,
    },
  );
  assert.equal(cards.length, 3, 'one card per action');
  assert.deepEqual(log, ['files.create:1', 'files.create:2', 'files.create:3']);
});

test('Confirm Actions: a "no" on the second stops the third; the first stays done', async () => {
  const log: string[] = [];
  const { cards } = await run(
    [
      { skill: 'files.create', args: { n: 1 } },
      { skill: 'files.create', args: { n: 2 } },
      { skill: 'files.create', args: { n: 3 } },
    ],
    {
      mode: 'confirmActions',
      skills: [fileSkill('files.create', log)],
      answers: [true, false],
    },
  );
  assert.equal(cards.length, 2);
  assert.deepEqual(log, ['files.create:1']);
});

test('Plan First: one card covers the plan, and exactly that plan runs', async () => {
  const log: string[] = [];
  const { cards, outcome } = await run(
    [
      { skill: 'files.create', args: { n: 1 } },
      { skill: 'files.create', args: { n: 2 } },
      { skill: 'files.create', args: { n: 3 } },
    ],
    { mode: 'planFirst', skills: [fileSkill('files.create', log)] },
  );
  assert.equal(cards.length, 1, 'asked once');
  assert.deepEqual(log, ['files.create:1', 'files.create:2', 'files.create:3']);
  assert.equal(outcome.ran, 3);
});

test('Plan First: declining the plan runs none of it', async () => {
  const log: string[] = [];
  const { cards } = await run(
    [
      { skill: 'files.create', args: { n: 1 } },
      { skill: 'files.create', args: { n: 2 } },
    ],
    { mode: 'planFirst', skills: [fileSkill('files.create', log)], answers: [false] },
  );
  assert.equal(cards.length, 1);
  assert.deepEqual(log, []);
});

test('Plan First: a plan of harmless steps shows no card at all', async () => {
  const m = machine('Notepad', [text('Untitled'), button('File')]);
  const { cards } = await run([{ skill: 'uia.invoke', args: { control: 'file' } }], {
    mode: 'planFirst',
    skills: createUiaSkills(m.platform),
  });
  assert.deepEqual(cards, []);
});

// ---- "That path is outside the folders Atlas can touch" ----------------------

function refusedSkill(log: string[], allowedAfter: { added: boolean }): Skill {
  return {
    id: 'files.open',
    label: 'Open a file',
    domain: 'files',
    description: 'opens a file',
    risk: 'safe',
    params: { path: { type: 'string', description: 'where' } },
    run: async (args) => {
      log.push(String(args.path));
      return allowedAfter.added
        ? { ok: true, message: 'Opened it.' }
        : { ok: false, error: 'That path is outside the folders Atlas can touch.' };
    },
  };
}

function runOpen(offer: ((args: unknown) => Promise<boolean>) | undefined, state = { added: false }) {
  const log: string[] = [];
  const said: string[] = [];
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany([refusedSkill(log, state)]);
  const ctx = {
    say: (t: string) => said.push(t),
    confirm: async () => true,
    offerFolder: offer
      ? async (args: unknown) => {
          const yes = await offer(args);
          if (yes) state.added = true;
          return yes;
        }
      : undefined,
  } as unknown as SkillContext;
  const plan: Plan = {
    source: 'grammar',
    intent: 'open',
    confidence: 1,
    steps: [{ skill: 'files.open', args: { path: 'D:/Oliver/Epic' } }],
  };
  return new Executor(registry).run(plan, ctx, {}).then((outcome) => ({ outcome, log, said }));
}

test('a refused path offers the folder, and "Add It?" retries the step once', async () => {
  const asked: unknown[] = [];
  const { outcome, log } = await runOpen(async (args) => {
    asked.push(args);
    return true;
  });
  assert.deepEqual(asked, [{ path: 'D:/Oliver/Epic' }]);
  assert.deepEqual(log, ['D:/Oliver/Epic', 'D:/Oliver/Epic'], 'ran, was refused, ran again');
  assert.isTrue(outcome.ok);
});

test('"Not Now" leaves the failure exactly as it was, with no retry', async () => {
  const { outcome, log, said } = await runOpen(async () => false);
  assert.equal(log.length, 1);
  assert.isFalse(outcome.ok);
  assert.match(said.join(' '), /outside the folders Atlas can touch/);
});

test('no way to ask (a surface without cards): the failure stands', async () => {
  const { outcome, log } = await runOpen(undefined);
  assert.equal(log.length, 1);
  assert.isFalse(outcome.ok);
});

test('a different failure never triggers the offer', async () => {
  let offered = false;
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany([
    {
      id: 'files.open',
      label: 'Open',
      domain: 'files',
      description: 'x',
      risk: 'safe',
      params: {},
      run: async () => ({ ok: false, error: 'File not found.' }),
    },
  ]);
  const ctx = {
    say: () => {},
    confirm: async () => true,
    offerFolder: async () => {
      offered = true;
      return true;
    },
  } as unknown as SkillContext;
  await new Executor(registry).run(
    { source: 'grammar', intent: 'x', confidence: 1, steps: [{ skill: 'files.open', args: {} }] },
    ctx,
    {},
  );
  assert.isFalse(offered);
});
