/**
 * Where input may go, and what may be claimed about it afterwards.
 *
 * The native decision (which process owns the target, the desktop, the token) is
 * tested in `input_guard.rs`. Here: that Atlas *acts* on that decision — a
 * Windows permission screen or a window above Atlas is refused, never asked
 * about — that a probe which cannot answer fails closed, that it holds in every
 * execution mode for every way of sending input, and that a result never says
 * more than was verified.
 */

import { assert, test } from 'vitest';
import {
  InputBlockedError,
  parseInputBlock,
  type ExecutionMode,
  type InputProbe,
  type InputTarget,
  type Plan,
  type Platform,
  type SkillContext,
  type UiaNode,
  type WindowEntry,
} from '@atlas/core';
import { Executor } from '../src/planner/executor';
import { SkillRegistry } from '../src/skills/registry';
import { createInputSkills } from '../src/skills/input-skills';
import { createKbmSkills } from '../src/skills/kbm-skills';
import { createUiaSkills } from '../src/skills/uia-skills';

const node = (
  role: string,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  value?: string,
): UiaNode => ({
  path: [],
  role,
  name,
  automationId: '',
  enabled: true,
  x,
  y,
  width: w,
  height: h,
  value,
  children: [],
});

const win = (id: string, title: string): WindowEntry => ({
  id,
  title,
  className: 'c',
  processName: 'app.exe',
  pid: 1,
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  minimized: false,
  maximized: false,
  active: true,
});

interface World {
  active: WindowEntry;
  focused: UiaNode | null;
  /** What the machine does to the focused field when text arrives. */
  typingLandsInField: boolean;
  /** Does pressing a key change the title? */
  keyChangesTitle: string | null;
  fieldValue: string | undefined;
  probe: ((t: InputTarget) => Promise<InputProbe>) | 'absent';
  /** Make the send itself throw a native refusal. */
  nativeRefuses: string | null;
}

function world(over: Partial<World> = {}) {
  const w: World = {
    active: win('w1', 'Notes'),
    focused: node('edit', 'Body', 0, 0, 500, 300, ''),
    typingLandsInField: true,
    keyChangesTitle: null,
    fieldValue: '',
    probe: async () => ({ allowed: true }),
    nativeRefuses: null,
    ...over,
  };
  const sent: string[] = [];
  const probed: InputTarget[] = [];
  const tree: UiaNode = {
    ...node('window', 'Notes', 0, 0, 800, 600),
    children: [node('button', 'Bold', 10, 10, 50, 20), node('button', 'Allow', 100, 100, 80, 30)],
  };
  const guard = () => {
    if (w.nativeRefuses) throw parseInputBlock(w.nativeRefuses) ?? new Error(w.nativeRefuses);
  };
  const platform = {
    capabilities: async () => ['input', 'ui-automation', 'windows'],
    listWindows: async () => [w.active],
    activeWindow: async () => w.active,
    uiaTree: async () => tree,
    uiaFocusedElement: async () => (w.focused ? { ...w.focused, value: w.fieldValue } : null),
    inputProbe:
      w.probe === 'absent'
        ? undefined
        : async (t: InputTarget) => {
            probed.push(t);
            return (w.probe as (t: InputTarget) => Promise<InputProbe>)(t);
          },
    mouseClick: async (x: number, y: number) => {
      guard();
      sent.push(`click:${x},${y}`);
      return true;
    },
    pressKey: async (k: string) => {
      guard();
      sent.push(`key:${k}`);
      if (w.keyChangesTitle) w.active = { ...w.active, title: w.keyChangesTitle };
      return true;
    },
    hotkey: async (m: string[], k: string) => {
      guard();
      sent.push(`hotkey:${[...m, k].join('+')}`);
      if (w.keyChangesTitle) w.active = { ...w.active, title: w.keyChangesTitle };
      return true;
    },
    typeText: async (t: string) => {
      guard();
      sent.push(`type:${t}`);
      if (w.typingLandsInField && w.fieldValue !== undefined) w.fieldValue += t;
      return true;
    },
    mouseDrag: async () => {
      guard();
      sent.push('drag');
      return true;
    },
    uiaInvoke: async () => {
      guard();
      sent.push('invoke');
      return true;
    },
    moveMouse: async () => true,
  } as unknown as Platform;
  return { w, platform, sent, probed };
}

async function run(
  platform: Platform,
  steps: Plan['steps'],
  opts: { mode?: ExecutionMode; answer?: boolean } = {},
) {
  const registry = new SkillRegistry({ capabilities: () => ['input', 'ui-automation', 'windows'] });
  registry.registerMany([
    ...createInputSkills(platform),
    ...createKbmSkills(platform),
    ...createUiaSkills(platform),
  ]);
  const cards: string[] = [];
  const said: string[] = [];
  const ctx: SkillContext = {
    say: (t) => said.push(t),
    showResults: () => {},
    confirm: async (q) => {
      cards.push(q);
      return opts.answer ?? true;
    },
  };
  const plan: Plan = { source: 'grammar', intent: 't', confidence: 1, steps };
  const outcome = await new Executor(registry).run(plan, ctx, { mode: opts.mode ?? 'doIt' });
  return { outcome, cards, said };
}

const UAC: InputProbe = {
  allowed: false,
  code: 'uac',
  message:
    'That’s a Windows permission or sign-in screen (consent.exe). Atlas never answers those.',
  image: 'consent.exe',
};
const ELEVATED: InputProbe = {
  allowed: false,
  code: 'elevated',
  message:
    'That window (regedit.exe) is running as administrator, and Windows doesn’t let a normal program control it.',
};

const EVERY_WAY_OF_SENDING: Array<[string, Plan['steps'][number]]> = [
  ['input.click', { skill: 'input.click', args: { x: 30, y: 20 } }],
  ['kbm.click', { skill: 'kbm.click', args: { x: 30, y: 20 } }],
  ['kbm.double_click', { skill: 'kbm.double_click', args: { x: 30, y: 20 } }],
  ['kbm.right_click', { skill: 'kbm.right_click', args: { x: 30, y: 20 } }],
  ['input.drag', { skill: 'input.drag', args: { fromX: 30, fromY: 20, toX: 40, toY: 30 } }],
  ['kbm.drag', { skill: 'kbm.drag', args: { fromX: 30, fromY: 20, toX: 40, toY: 30 } }],
  ['input.pressKey enter', { skill: 'input.pressKey', args: { key: 'enter' } }],
  ['kbm.press_key space', { skill: 'kbm.press_key', args: { key: 'space' } }],
  ['kbm.hotkey ctrl+enter', { skill: 'kbm.hotkey', args: { combo: 'ctrl+enter' } }],
  ['kbm.key_sequence', { skill: 'kbm.key_sequence', args: { sequence: 'enter' } }],
  ['kbm.type_text with a line break', { skill: 'kbm.type_text', args: { text: 'a\nb' } }],
  ['kbm.click_element', { skill: 'kbm.click_element', args: { control: 'bold' } }],
  ['uia.invoke', { skill: 'uia.invoke', args: { control: 'bold' } }],
];

// ---- the native refusal reaches the person -----------------------------------------------

test('a native refusal is recognised, keeps its code, and keeps its reason', () => {
  const e = parseInputBlock('BLOCKED:uac:That is a Windows permission screen.')!;
  assert.instanceOf(e, InputBlockedError);
  assert.equal(e.code, 'uac');
  assert.equal(e.message, 'That is a Windows permission screen.');
  assert.isNull(parseInputBlock('Windows refused: something else'));
  assert.equal(
    parseInputBlock('BLOCKED:made-up:x')!.code,
    'unknown',
    'an unknown code fails closed',
  );
});

// ---- UAC and elevated targets: refused, never asked ------------------------------------------

test('every way of sending input refuses a Windows permission screen — with no card and nothing sent', async () => {
  for (const [name, step] of EVERY_WAY_OF_SENDING) {
    const { platform, sent } = world({ probe: async () => UAC });
    const { outcome, cards, said } = await run(platform, [step]);
    assert.deepEqual(sent, [], `${name}: nothing was sent`);
    assert.deepEqual(cards, [], `${name}: a refusal is not a question`);
    assert.isFalse(outcome.ok, name);
    assert.match(outcome.outcomes[0]!.error ?? '', /permission or sign-in screen/, name);
    assert.match(said.join(' '), /Atlas never answers those/, name);
  }
});

test('the same for a window running above Atlas, whose input Windows would silently drop', async () => {
  for (const [name, step] of EVERY_WAY_OF_SENDING) {
    const { platform, sent } = world({ probe: async () => ELEVATED });
    const { outcome, cards } = await run(platform, [step]);
    assert.deepEqual(sent, [], name);
    assert.deepEqual(cards, [], name);
    assert.match(outcome.outcomes[0]!.error ?? '', /running as administrator/, name);
  }
});

test('a "yes" cannot unlock it — there is no card to say yes to', async () => {
  const { platform, sent } = world({ probe: async () => UAC });
  const { cards } = await run(platform, [{ skill: 'kbm.click', args: { x: 100, y: 100 } }], {
    answer: true,
  });
  assert.deepEqual(cards, []);
  assert.deepEqual(sent, []);
});

test('the refusal holds in all three execution modes', async () => {
  for (const mode of ['doIt', 'planFirst', 'confirmActions'] as ExecutionMode[]) {
    const { platform, sent } = world({ probe: async () => UAC });
    const { outcome } = await run(platform, [{ skill: 'kbm.click', args: { x: 30, y: 20 } }], {
      mode,
    });
    assert.deepEqual(sent, [], mode);
    assert.isFalse(outcome.ok, mode);
  }
});

test('a probe that exists but cannot answer fails closed — not being able to check is not "safe"', async () => {
  const { platform, sent } = world({
    probe: async () => {
      throw new Error('native side unavailable');
    },
  });
  const { outcome, cards } = await run(platform, [{ skill: 'kbm.click', args: { x: 30, y: 20 } }]);
  assert.deepEqual(sent, []);
  assert.deepEqual(cards, []);
  assert.match(outcome.outcomes[0]!.error ?? '', /couldn’t check where that input would go/);
});

test('the probe is asked about the real target: the point, the window, or the foreground', async () => {
  const a = world();
  await run(a.platform, [{ skill: 'kbm.click', args: { x: 30, y: 20 } }]);
  assert.deepEqual(a.probed[0], { x: 30, y: 20 });

  const b = world();
  await run(b.platform, [{ skill: 'kbm.press_key', args: { key: 'enter' } }]);
  assert.deepEqual(b.probed[0], {}, 'no point: the foreground window');

  const c = world();
  await run(c.platform, [{ skill: 'uia.invoke', args: { control: 'bold' } }]);
  assert.deepEqual(c.probed[0], { windowId: 'w1' });
});

test('defence in depth: if the renderer check is bypassed, the native refusal still stops it and says why', async () => {
  // No probe at all (a build or a test double without one), so the early check
  // is skipped — the native input command itself refuses.
  const { platform, sent } = world({
    probe: 'absent',
    nativeRefuses:
      'BLOCKED:uac:That’s a Windows permission or sign-in screen (consent.exe). Atlas never answers those.',
  });
  const { outcome } = await run(platform, [{ skill: 'kbm.click', args: { x: 30, y: 20 } }]);
  assert.deepEqual(sent, []);
  assert.isFalse(outcome.ok);
  assert.match(outcome.outcomes[0]!.error ?? '', /permission or sign-in screen/);
  assert.equal((outcome.outcomes[0]!.data as { input?: string })?.input, 'blocked');
});

test('a plain key that presses nothing is not held up by the probe answering "elevated" for someone else', async () => {
  // Tab does not activate the focused control, so it is not judged as a press;
  // the native command still refuses a protected target on its own.
  const { platform, sent } = world({ probe: async () => ({ allowed: true }) });
  await run(platform, [{ skill: 'kbm.press_key', args: { key: 'tab' } }]);
  assert.deepEqual(sent, ['key:tab']);
});

// ---- sent, changed, verified, failed ------------------------------------------------------------

test('typing into a readable field is verified by reading the text back', async () => {
  const { platform } = world({ fieldValue: '' });
  const { outcome } = await run(platform, [{ skill: 'kbm.type_text', args: { text: 'Test' } }]);
  const r = outcome.outcomes[0]!;
  assert.isTrue(r.ok);
  assert.equal((r.data as { input: string }).input, 'verified');
  assert.match(r.message ?? '', /verified: it is now in the field/);
});

test('typing into a control that will not say what it holds is "sent, not verified" — never "done"', async () => {
  const { platform } = world({ fieldValue: undefined });
  const { outcome } = await run(platform, [{ skill: 'kbm.type_text', args: { text: 'Test' } }]);
  const r = outcome.outcomes[0]!;
  assert.isTrue(r.ok);
  assert.equal((r.data as { input: string }).input, 'sent');
  assert.match(r.message ?? '', /sent, not verified/);
  assert.notMatch(r.message ?? '', /(?<!not )verified: /);
});

test('the keys were "sent" but the readable field does not contain them: that is a failure, not a success', async () => {
  // The blocked-input case that no API reports: everything returned normally,
  // and the text is not there.
  const { platform } = world({ fieldValue: '', typingLandsInField: false });
  const { outcome } = await run(platform, [{ skill: 'kbm.type_text', args: { text: 'Test' } }]);
  const r = outcome.outcomes[0]!;
  assert.isFalse(r.ok);
  assert.match(r.error ?? '', /isn't in the field/);
  assert.match(r.error ?? '', /not calling that done/);
});

test('text that was already in the field is not counted as the text just typed', async () => {
  const { platform } = world({ fieldValue: 'Test', typingLandsInField: false });
  const { outcome } = await run(platform, [{ skill: 'kbm.type_text', args: { text: 'Test' } }]);
  assert.isFalse(outcome.outcomes[0]!.ok, 'the old occurrence is not evidence');
});

test('a key that changes the window is reported as an observed change, with the caveat', async () => {
  const { platform } = world({ keyChangesTitle: 'new 2 - Notes' });
  const { outcome } = await run(platform, [{ skill: 'kbm.hotkey', args: { combo: 'ctrl+n' } }]);
  const r = outcome.outcomes[0]!;
  assert.isTrue(r.ok);
  assert.equal((r.data as { input: string }).input, 'changed');
  assert.match(r.message ?? '', /window title changed/);
  assert.match(r.message ?? '', /can't confirm that is the effect you wanted/);
});

test('when nothing readable changes, it says "sent, not verified" rather than claiming success', async () => {
  const { platform } = world();
  const { outcome } = await run(platform, [{ skill: 'kbm.hotkey', args: { combo: 'ctrl+n' } }]);
  const r = outcome.outcomes[0]!;
  assert.isTrue(r.ok);
  assert.equal((r.data as { input: string }).input, 'sent');
  assert.match(r.message ?? '', /sent, not verified/);
});

test('a click is reported as sent unless something observable moved', async () => {
  const { platform } = world();
  const { outcome } = await run(platform, [{ skill: 'kbm.click', args: { x: 30, y: 20 } }]);
  assert.equal((outcome.outcomes[0]!.data as { input: string }).input, 'sent');
});

test('a platform that could not send at all is a failure, and says nothing was sent', async () => {
  const { platform } = world();
  (platform as { hotkey: unknown }).hotkey = async () => false;
  const { outcome } = await run(platform, [{ skill: 'kbm.hotkey', args: { combo: 'ctrl+n' } }]);
  assert.isFalse(outcome.outcomes[0]!.ok);
});

test('a password field is never read back — so typing into one is only ever "sent"', async () => {
  // The native side leaves `value` off a password field entirely.
  const { platform } = world({
    focused: { ...node('edit', 'Password', 0, 0, 200, 20), password: true },
    fieldValue: undefined,
  });
  const { outcome } = await run(platform, [{ skill: 'kbm.type_text', args: { text: 'hunter2' } }]);
  const r = outcome.outcomes[0]!;
  assert.equal((r.data as { input: string }).input, 'sent');
  assert.notInclude(r.message ?? '', 'hunter2', 'the secret is not echoed back either');
});
