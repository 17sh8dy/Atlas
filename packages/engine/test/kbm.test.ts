/**
 * `kbm.*` — keyboard and mouse, and the rule that a coordinate is not a target.
 *
 * Through the real Executor and the real skills; only the machine is faked.
 * The claim under test: a click or Enter is judged by what it would land on.
 * A verified harmless control goes ahead; one that would pay/send/delete asks by
 * name; and a spot Atlas cannot identify asks rather than being assumed fine.
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
import { createKbmSkills, parseSequence } from '../src/skills/kbm-skills';
import { createInputSkills } from '../src/skills/input-skills';

function node(
  role: string,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  children: UiaNode[] = [],
): UiaNode {
  return {
    path: [],
    role,
    name,
    automationId: '',
    enabled: true,
    x,
    y,
    width: w,
    height: h,
    children,
  };
}

const WIN: WindowEntry = {
  id: 'w1',
  title: 'Checkout — Contoso',
  className: 'c',
  processName: 'browser.exe',
  pid: 1,
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  minimized: false,
  maximized: false,
  active: true,
};

// Buttons: File at (10..60, 10..30), Pay now at (100..200, 100..140).
const TREE = node('window', 'Checkout — Contoso', 0, 0, 800, 600, [
  node('text', 'Order total $54.00', 100, 60, 200, 20),
  node('button', 'File', 10, 10, 50, 20),
  node('button', 'Pay now', 100, 100, 100, 40),
  node('button', 'Play', 300, 100, 60, 40),
  node('pane', '', 0, 200, 800, 400),
]);

interface Options {
  tree?: UiaNode | null;
  windows?: WindowEntry[];
  focused?: UiaNode | null;
}

function machine(o: Options = {}) {
  const clicks: Array<{ x: number; y: number; button: string; double: boolean }> = [];
  const keys: string[] = [];
  const typed: string[] = [];
  const platform = {
    capabilities: async () => ['input', 'ui-automation', 'windows'],
    listWindows: async () => o.windows ?? [WIN],
    activeWindow: async () => (o.windows ?? [WIN])[0] ?? null,
    uiaTree: async () => (o.tree === undefined ? TREE : o.tree),
    uiaFocusedElement: async () => (o.focused === undefined ? null : o.focused),
    mouseClick: async (x: number, y: number, button: string, double: boolean) => {
      clicks.push({ x, y, button, double });
      return true;
    },
    pressKey: async (k: string) => {
      keys.push(k);
      return true;
    },
    hotkey: async (mods: string[], k: string) => {
      keys.push([...mods, k].join('+'));
      return true;
    },
    typeText: async (t: string) => {
      typed.push(t);
      return true;
    },
    moveMouse: async () => true,
    cursorPosition: async () => ({ x: 5, y: 6 }),
    mouseScroll: async () => true,
  } as unknown as Platform;
  return { platform, clicks, keys, typed };
}

async function run(
  platform: Platform,
  steps: Array<{ skill: string; args: Record<string, string | number | boolean> }>,
  opts: { mode?: ExecutionMode; answer?: boolean; extra?: Skill[] } = {},
) {
  const registry = new SkillRegistry({ capabilities: () => ['input', 'ui-automation', 'windows'] });
  registry.registerMany([
    ...createKbmSkills(platform),
    ...createInputSkills(platform),
    ...(opts.extra ?? []),
  ]);
  const cards: Array<{ q: string; d?: string }> = [];
  const ctx: SkillContext = {
    say: () => {},
    showResults: () => {},
    confirm: async (q, d) => {
      cards.push({ q, d });
      return opts.answer ?? true;
    },
  };
  const plan: Plan = { source: 'grammar', intent: 't', confidence: 1, steps };
  const outcome = await new Executor(registry).run(plan, ctx, { mode: opts.mode ?? 'doIt' });
  return { outcome, cards };
}

// ---- the toolset exists --------------------------------------------------------

test('every requested kbm tool is registered', () => {
  const ids = createKbmSkills(machine().platform).map((s) => s.id);
  for (const id of [
    'kbm.click',
    'kbm.double_click',
    'kbm.right_click',
    'kbm.move_mouse',
    'kbm.scroll',
    'kbm.press_key',
    'kbm.hotkey',
    'kbm.type_text',
    'kbm.key_sequence',
    'kbm.get_active_window',
    'kbm.get_ui_elements',
  ]) {
    assert.include(ids, id);
  }
});

// ---- coordinate clicks ---------------------------------------------------------

test('a click on a verified harmless control goes ahead with no card', async () => {
  const m = machine();
  const { cards } = await run(m.platform, [{ skill: 'kbm.click', args: { x: 30, y: 20 } }]);
  assert.deepEqual(cards, []);
  assert.deepEqual(m.clicks, [{ x: 30, y: 20, button: 'left', double: false }]);
});

test('a click on a payment button asks, by name, and does nothing until you agree', async () => {
  const m = machine();
  const { cards } = await run(m.platform, [{ skill: 'kbm.click', args: { x: 150, y: 120 } }], {
    answer: false,
  });
  assert.equal(cards.length, 1);
  assert.match(cards[0]!.q, /Pay now/);
  assert.match(cards[0]!.q, /150, 120/);
  assert.deepEqual(m.clicks, []);
});

test('approving names the same target it will click', async () => {
  const m = machine();
  await run(m.platform, [{ skill: 'kbm.click', args: { x: 150, y: 120 } }], { answer: true });
  assert.equal(m.clicks.length, 1);
});

test('a spot with nothing identifiable asks, and says it cannot tell', async () => {
  const m = machine();
  const { cards } = await run(m.platform, [{ skill: 'kbm.click', args: { x: 400, y: 400 } }], {
    answer: false,
  });
  assert.equal(cards.length, 1);
  assert.match(cards[0]!.d ?? '', /cannot tell/);
  assert.deepEqual(m.clicks, []);
});

test('a click where no window is asks', async () => {
  const m = machine({ windows: [] });
  const { cards } = await run(m.platform, [{ skill: 'kbm.click', args: { x: 30, y: 20 } }], {
    answer: false,
  });
  assert.equal(cards.length, 1);
  assert.deepEqual(m.clicks, []);
});

test('a window whose controls cannot be read asks', async () => {
  const m = machine({ tree: null });
  const { cards } = await run(m.platform, [{ skill: 'kbm.click', args: { x: 30, y: 20 } }], {
    answer: false,
  });
  assert.equal(cards.length, 1);
  assert.match(cards[0]!.d ?? '', /cannot read/);
});

test('double, right and middle clicks are checked the same way', async () => {
  for (const skill of ['kbm.double_click', 'kbm.right_click', 'kbm.middle_click']) {
    const m = machine();
    const ok = await run(m.platform, [{ skill, args: { x: 30, y: 20 } }]);
    assert.deepEqual(ok.cards, [], `${skill} on File`);
    const pay = await run(m.platform, [{ skill, args: { x: 150, y: 120 } }], { answer: false });
    assert.equal(pay.cards.length, 1, `${skill} on Pay now`);
  }
});

test('the older input.click cannot be used to get round it', async () => {
  const m = machine();
  const { cards } = await run(m.platform, [{ skill: 'input.click', args: { x: 150, y: 120 } }], {
    answer: false,
  });
  assert.equal(cards.length, 1);
  assert.deepEqual(m.clicks, []);
});

test('a click checks in every execution mode', async () => {
  for (const mode of ['doIt', 'planFirst', 'confirmActions'] as ExecutionMode[]) {
    const m = machine();
    const { cards } = await run(m.platform, [{ skill: 'kbm.click', args: { x: 150, y: 120 } }], {
      mode,
      answer: false,
    });
    assert.equal(cards.length, 1, mode);
  }
});

test('dragging onto something consequential asks, and names the drop', async () => {
  const m = machine();
  const { cards } = await run(
    m.platform,
    [{ skill: 'kbm.drag', args: { fromX: 30, fromY: 20, toX: 150, toY: 120 } }],
    { answer: false },
  );
  assert.equal(cards.length, 1);
  assert.match(cards[0]!.d ?? '', /dropped/);
});

// ---- a control found by name ---------------------------------------------------

test('click_element clicks the centre of a harmless control it found', async () => {
  const m = machine();
  const { cards } = await run(m.platform, [
    { skill: 'kbm.click_element', args: { control: 'play', mode: 'real' } },
  ]);
  assert.deepEqual(cards, []);
  assert.deepEqual(m.clicks, [{ x: 330, y: 120, button: 'left', double: false }]);
});

test('click_element on a payment control asks first', async () => {
  const m = machine();
  const { cards } = await run(
    m.platform,
    [{ skill: 'kbm.click_element', args: { control: 'pay now' } }],
    {
      answer: false,
    },
  );
  assert.equal(cards.length, 1);
  assert.deepEqual(m.clicks, []);
});

test('click_element reports a control it cannot find instead of guessing', async () => {
  const m = machine();
  const { outcome } = await run(m.platform, [
    { skill: 'kbm.click_element', args: { control: 'nope' } },
  ]);
  assert.isFalse(outcome.ok);
  assert.deepEqual(m.clicks, []);
});

// ---- keys ---------------------------------------------------------------------

test('Enter on a focused payment button asks; Tab does not', async () => {
  const m = machine({ focused: node('button', 'Pay now', 100, 100, 100, 40) });
  const enter = await run(m.platform, [{ skill: 'kbm.press_key', args: { key: 'enter' } }], {
    answer: false,
  });
  assert.equal(enter.cards.length, 1);
  assert.deepEqual(m.keys, []);
  const tab = await run(m.platform, [{ skill: 'kbm.press_key', args: { key: 'tab' } }]);
  assert.deepEqual(tab.cards, []);
  assert.deepEqual(m.keys, ['tab']);
});

test('Enter with nothing identifiable focused asks', async () => {
  const m = machine({ focused: null });
  const { cards } = await run(m.platform, [{ skill: 'kbm.press_key', args: { key: 'enter' } }], {
    answer: false,
  });
  assert.equal(cards.length, 1);
});

test('Enter in an ordinary text field is just Enter', async () => {
  const m = machine({
    windows: [{ ...WIN, title: 'Notes' }],
    focused: node('edit', 'Search', 10, 10, 200, 20),
  });
  const { cards } = await run(m.platform, [{ skill: 'kbm.press_key', args: { key: 'enter' } }]);
  assert.deepEqual(cards, []);
  assert.deepEqual(m.keys, ['enter']);
});

test('the same Enter on a checkout page asks — the page is the context', async () => {
  const m = machine({ focused: node('edit', 'Search', 10, 10, 200, 20) });
  const { cards } = await run(m.platform, [{ skill: 'kbm.press_key', args: { key: 'enter' } }], {
    answer: false,
  });
  assert.equal(cards.length, 1);
});

test('Enter in a password field asks', async () => {
  const m = machine({ focused: node('edit', 'Password', 10, 10, 200, 20) });
  const { cards } = await run(m.platform, [{ skill: 'kbm.press_key', args: { key: 'enter' } }], {
    answer: false,
  });
  assert.equal(cards.length, 1);
});

test('typing a line break is judged like Enter', async () => {
  const m = machine({ focused: null });
  const plain = await run(m.platform, [{ skill: 'kbm.type_text', args: { text: 'hello' } }]);
  assert.deepEqual(plain.cards, []);
  const lined = await run(
    m.platform,
    [{ skill: 'kbm.type_text', args: { text: 'hello\nthere' } }],
    {
      answer: false,
    },
  );
  assert.equal(lined.cards.length, 1);
});

test('Alt+F4 still asks, on its own and inside a sequence', async () => {
  const m = machine();
  const hot = await run(m.platform, [{ skill: 'kbm.hotkey', args: { combo: 'alt+f4' } }], {
    answer: false,
  });
  assert.equal(hot.cards.length, 1);
  const seq = await run(
    m.platform,
    [{ skill: 'kbm.key_sequence', args: { sequence: 'ctrl+a, alt+f4' } }],
    {
      answer: false,
    },
  );
  assert.equal(seq.cards.length, 1);
  assert.deepEqual(m.keys, []);
});

// ---- key sequences ---------------------------------------------------------------

test('a sequence parses keys, combos and typed text in order', () => {
  assert.deepEqual(parseSequence('ctrl+a, delete, type:hello world, enter'), [
    { kind: 'combo', combo: 'ctrl+a' },
    { kind: 'combo', combo: 'delete' },
    { kind: 'text', text: 'hello world' },
    { kind: 'combo', combo: 'enter' },
  ]);
});

test('a harmless sequence runs in order with no card', async () => {
  const m = machine();
  const { cards, outcome } = await run(m.platform, [
    { skill: 'kbm.key_sequence', args: { sequence: 'ctrl+a, delete, type:hi' } },
  ]);
  assert.deepEqual(cards, []);
  assert.deepEqual(m.keys, ['ctrl+a', 'delete']);
  assert.deepEqual(m.typed, ['hi']);
  assert.isTrue(outcome.ok);
});

test('an Enter that is not first is always asked about — focus may have moved', async () => {
  const m = machine({ focused: node('edit', 'Search', 10, 10, 200, 20) });
  const { cards } = await run(
    m.platform,
    [{ skill: 'kbm.key_sequence', args: { sequence: 'ctrl+l, type:example.com, enter' } }],
    { answer: false },
  );
  assert.equal(cards.length, 1);
  assert.deepEqual(m.keys, []);
});

// ---- reading the screen --------------------------------------------------------

test('get_ui_elements lists what can be operated, with click coordinates', async () => {
  const m = machine();
  const { outcome } = await run(m.platform, [{ skill: 'kbm.get_ui_elements', args: {} }]);
  const data = outcome.outcomes[0]!.data as {
    elements: Array<{ name: string; x: number; y: number }>;
  };
  const pay = data.elements.find((e) => e.name === 'Pay now')!;
  assert.deepEqual([pay.x, pay.y], [150, 120]);
  assert.notInclude(
    data.elements.map((e) => e.name),
    'Order total $54.00',
    'labels are left out unless asked for',
  );
});

test('get_active_window reports the window in front', async () => {
  const m = machine();
  const { outcome } = await run(m.platform, [{ skill: 'kbm.get_active_window', args: {} }]);
  assert.match(outcome.outcomes[0]!.message ?? '', /Checkout/);
});
