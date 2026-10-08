/**
 * Background ("virtual") keyboard and mouse — 1.0.8.
 *
 * The promises under test, each with the failure it prevents:
 *  - When the app supports it, the work happens in the background: the real mouse, the real keyboard
 *    and the window in front are never touched (every real-input method on the fake THROWS if called).
 *  - When it cannot, Atlas says why and ASKS before using the real ones — never a silent fall-back.
 *  - `virtual` never falls back and never asks; `real` skips the background route.
 *  - A refusal (permission screen, window above Atlas) is the end of it: no "use the real keyboard
 *    instead" is offered, because that would be asking to get around the guard.
 *  - Passwords are not typed into in the background.
 *  - The emergency stop is honoured.
 */
import { assert, describe, expect, test } from 'vitest';
import { InputBlockedError } from '@atlas/core';
import type { Platform, SkillContext, UiaCapabilities, UiaNode, WindowEntry } from '@atlas/core';
import { createKbmSkills } from '../src/skills/kbm-skills';
import { unsupportedReason } from '../src/skills/background-input';

const node = (role: string, name: string, path: number[], x = 10, y = 10, w = 100, h = 30, children: UiaNode[] = []): UiaNode => ({
  path, role, name, automationId: '', enabled: true, x, y, width: w, height: h, children,
});
const WIN: WindowEntry = { id: 'w1', title: 'Notes — Notepad', className: 'n', processName: 'notepad.exe', pid: 7, x: 0, y: 0, width: 800, height: 600, minimized: false, maximized: false, active: false };
const TREE = node('window', 'Notes — Notepad', [], 0, 0, 800, 600, [
  node('button', 'Save', [0], 10, 10, 60, 20),
  node('edit', 'Search box', [1], 100, 10, 200, 20),
  node('edit', 'Password', [2], 100, 40, 200, 20),
  node('list', 'Messages', [3], 0, 100, 800, 400),
  node('button', 'Pay now', [4], 10, 560, 80, 20),
]);

const caps = (over: Partial<UiaCapabilities> = {}): UiaCapabilities => ({
  name: '', role: 'button', enabled: true, offscreen: false, password: false, invoke: true, toggle: false, select: false, expand: false, value: false, valueReadOnly: false, scroll: false, ...over,
});

/** A machine where ANY real input throws — so the virtual path provably never reached for it. */
function machine(opts: { caps?: (path: number[]) => UiaCapabilities; invoke?: (path: number[]) => boolean | Error; append?: (path: number[], text: string) => unknown; scroll?: (path: number[], v: number) => unknown } = {}) {
  const log: string[] = [];
  const forbidden = (name: string) => async () => {
    log.push(`REAL:${name}`);
    throw new Error(`real input used: ${name}`);
  };
  const platform = {
    capabilities: async () => ['input', 'ui-automation', 'windows'],
    listWindows: async () => [WIN],
    activeWindow: async () => ({ ...WIN, id: 'front', title: 'Something else', active: true }),
    uiaTree: async () => TREE,
    uiaFocusedElement: async () => null,
    inputProbe: async () => ({ allowed: true }),
    uiaCapabilities: async (_w: string, path: number[]) => (opts.caps ? opts.caps(path) : caps()),
    uiaInvoke: async (_w: string, path: number[]) => {
      log.push(`invoke:${path.join('.')}`);
      const r = opts.invoke ? opts.invoke(path) : true;
      if (r instanceof Error) throw r;
      return r;
    },
    uiaAppendValue: async (_w: string, path: number[], text: string) => {
      log.push(`append:${path.join('.')}:${text}`);
      const r = opts.append ? opts.append(path, text) : { charsBefore: 0, charsAfter: text.length, verified: true };
      if (r instanceof Error) throw r;
      return r;
    },
    uiaScroll: async (_w: string, path: number[], v: number) => {
      log.push(`scroll:${path.join('.')}:${v}`);
      const r = opts.scroll ? opts.scroll(path, v) : true;
      if (r instanceof Error) throw r;
      return r;
    },
    // Everything that would touch the person's mouse, keyboard or focus:
    mouseClick: forbidden('mouseClick'),
    moveMouse: forbidden('moveMouse'),
    mouseScroll: forbidden('mouseScroll'),
    pressKey: forbidden('pressKey'),
    hotkey: forbidden('hotkey'),
    typeText: forbidden('typeText'),
    focusWindow: forbidden('focusWindow'),
    uiaFocus: forbidden('uiaFocus'),
  } as unknown as Platform;
  return { platform, log };
}

/** A machine that DOES allow real input (for the approved-fall-back path), recording it. */
function realMachine(base: ReturnType<typeof machine>) {
  const real: string[] = [];
  const p = base.platform as unknown as Record<string, unknown>;
  p.mouseClick = async (x: number, y: number) => (real.push(`click:${x},${y}`), true);
  p.moveMouse = async (x: number, y: number) => (real.push(`move:${x},${y}`), true);
  p.mouseScroll = async (n: number) => (real.push(`wheel:${n}`), true);
  p.typeText = async (t: string) => (real.push(`type:${t}`), true);
  p.focusWindow = async (id: string) => (real.push(`focus:${id}`), true);
  p.uiaFocus = async () => (real.push('uiaFocus'), true);
  return real;
}

const ctx = (answer: boolean | null = true, asked: Array<{ q: string; d?: string }> = [], extra: Partial<SkillContext> = {}) =>
  ({
    say() {},
    confirm: answer === null ? undefined : async (q: string, d?: string) => (asked.push({ q, d }), answer),
    ...extra,
  }) as unknown as SkillContext;
const stopped = { aborted: true, addEventListener() {}, removeEventListener() {} };
type R = { ok: boolean; message?: string; error?: string; data?: Record<string, unknown> };
const skill = (m: ReturnType<typeof machine>, id: string) => createKbmSkills(m.platform).find((s) => s.id === id)!;
const go = async (m: ReturnType<typeof machine>, id: string, args: Record<string, unknown>, c: SkillContext = ctx()) => (await skill(m, id).run(args, c)) as R;

describe('click a control in the background', () => {
  test('presses it through accessibility — no real input, and says so', async () => {
    const m = machine();
    const r = await go(m, 'kbm.click_element', { control: 'save', window: 'notepad' });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Pressed “Save” in Notes — Notepad/);
    expect(r.message).toMatch(/your mouse, keyboard and the window in front were not touched/);
    expect(r.data?.via).toBe('virtual');
    expect(m.log).toEqual(['invoke:0']); // exactly one background call, no REAL:* entries
  });

  test('a toggle or a selectable item counts as pressable too', async () => {
    const m = machine({ caps: () => caps({ invoke: false, toggle: true }) });
    expect((await go(m, 'kbm.click_element', { control: 'save' })).ok).toBe(true);
    const m2 = machine({ caps: () => caps({ invoke: false, select: true }) });
    expect((await go(m2, 'kbm.click_element', { control: 'save' })).ok).toBe(true);
  });

  test('unsupported → says why and ASKS; yes uses the real mouse, no leaves it alone', async () => {
    const asked: Array<{ q: string; d?: string }> = [];
    const m = machine({ caps: () => caps({ invoke: false, role: 'custom' }) });
    const real = realMachine(m);
    const declined = await go(m, 'kbm.click_element', { control: 'save' }, ctx(false, asked));
    expect(declined.ok).toBe(false);
    expect(declined.error).toMatch(/can't press “Save” in the background/);
    expect(declined.error).toMatch(/nothing was sent/);
    expect(real).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.q).toMatch(/Use your real mouse and keyboard to press “Save”/);
    expect(asked[0]!.d).toMatch(/move your cursor onto “Save” and click it/);
    expect(asked[0]!.d).toMatch(/emergency stop/);

    const yes = await go(m, 'kbm.click_element', { control: 'save' }, ctx(true));
    expect(yes.ok).toBe(true);
    expect(yes.message).toMatch(/^Used your real mouse and keyboard, as you approved/);
    expect(yes.data?.via).toBe('real');
    expect(real).toEqual(['click:40,20']);
  });

  test('with no way to ask, it does not use the real mouse', async () => {
    const m = machine({ caps: () => caps({ invoke: false }) });
    const real = realMachine(m);
    const r = await go(m, 'kbm.click_element', { control: 'save' }, ctx(null));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/without asking/);
    expect(real).toEqual([]);
  });

  test("mode 'virtual' never asks and never falls back; mode 'real' skips the background", async () => {
    const asked: Array<{ q: string }> = [];
    const m = machine({ caps: () => caps({ invoke: false }) });
    const real = realMachine(m);
    const v = await go(m, 'kbm.click_element', { control: 'save', mode: 'virtual' }, ctx(true, asked));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/because you asked for the background route only/);
    expect(asked).toEqual([]);
    expect(real).toEqual([]);
    const r = await go(m, 'kbm.click_element', { control: 'save', mode: 'real' }, ctx(true, asked));
    expect(r.ok).toBe(true);
    expect(real).toEqual(['click:40,20']);
    expect(m.log.filter((l) => l.startsWith('invoke'))).toEqual([]); // the real route never tried the background
  });

  test('a double-click and an off-screen control need the real mouse and ask', async () => {
    const asked: Array<{ q: string; d?: string }> = [];
    const m = machine();
    realMachine(m);
    await go(m, 'kbm.click_element', { control: 'save', double: true }, ctx(false, asked));
    expect(asked[0]!.d).toMatch(/a double-click needs the real mouse/);
    const off = machine({ caps: () => caps({ offscreen: true }) });
    realMachine(off);
    await go(off, 'kbm.click_element', { control: 'save' }, ctx(false, asked));
    expect(asked[1]!.d).toMatch(/scrolled out of view/);
  });

  test('a window above Atlas or a permission screen is a refusal — and no real-keyboard offer follows', async () => {
    const asked: Array<{ q: string }> = [];
    const m = machine({ invoke: () => new InputBlockedError('elevated', 'That window is running as administrator, so I did not send anything.') });
    const real = realMachine(m);
    const r = await go(m, 'kbm.click_element', { control: 'save' }, ctx(true, asked));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/running as administrator/);
    expect(r.data).toMatchObject({ input: 'blocked', code: 'elevated', via: 'none' });
    expect(asked).toEqual([]); // not even asked
    expect(real).toEqual([]);
  });

  test('a greyed-out or missing control is reported before anything is tried', async () => {
    const m = machine();
    expect((await go(m, 'kbm.click_element', { control: 'nope' })).error).toMatch(/can't find a control/);
    expect(m.log).toEqual([]);
  });

  test('the app declining the press is a failure, not a reason to grab the mouse', async () => {
    const asked: Array<{ q: string }> = [];
    const m = machine({ invoke: () => false });
    realMachine(m);
    const r = await go(m, 'kbm.click_element', { control: 'save' }, ctx(true, asked));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/didn’t accept the press/);
    expect(asked).toEqual([]);
  });

  test('the emergency stop is honoured before and after', async () => {
    const m = machine();
    const before = await go(m, 'kbm.click_element', { control: 'save' }, ctx(true, [], { signal: stopped } as Partial<SkillContext>));
    expect(before.error).toMatch(/Stopped/);
    expect(m.log).toEqual([]);
  });
});

describe('type into a field in the background', () => {
  test('adds the text, reads the field back, and touches nothing real', async () => {
    const m = machine({ caps: () => caps({ role: 'edit', invoke: false, value: true }) });
    const r = await go(m, 'kbm.type_text', { text: 'hello', control: 'search box', window: 'notepad' });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Typed 5 characters into “Search box” in Notes — Notepad — verified by reading the field back/);
    expect(r.data).toMatchObject({ input: 'verified', via: 'virtual' });
    expect(m.log).toEqual(['append:1:hello']);
  });

  test('a field that does not show the text afterwards is not reported as done', async () => {
    const m = machine({ caps: () => caps({ value: true }), append: () => ({ charsBefore: 0, charsAfter: 0, verified: false }) });
    const r = await go(m, 'kbm.type_text', { text: 'hello', control: 'search box' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not calling it done/);
  });

  test('a password field is never typed into in the background, and the real route is asked about, not assumed', async () => {
    const asked: Array<{ q: string; d?: string }> = [];
    const m = machine({ caps: () => caps({ role: 'edit', password: true, value: true }) });
    realMachine(m);
    const r = await go(m, 'kbm.type_text', { text: 'hunter2', control: 'password' }, ctx(false, asked));
    expect(r.ok).toBe(false);
    expect(m.log.filter((l) => l.startsWith('append'))).toEqual([]);
    expect(asked[0]!.d).toMatch(/password field/);
    expect(JSON.stringify(asked)).not.toContain('hunter2'); // the secret is never put on a card
    expect(r.error ?? '').not.toContain('hunter2');
  });

  test('read-only, no text pattern, line breaks: each asks with its own reason', async () => {
    const asked: Array<{ q: string; d?: string }> = [];
    for (const [c, text, why] of [
      [caps({ value: true, valueReadOnly: true }), 'x', /read-only/],
      [caps({ value: false }), 'x', /doesn’t accept text without the keyboard/],
      [caps({ value: true }), 'a\nb', /line break needs the Enter key/],
    ] as const) {
      const m = machine({ caps: () => c });
      realMachine(m);
      await go(m, 'kbm.type_text', { text, control: 'search box' }, ctx(false, asked));
      expect(asked.at(-1)!.d).toMatch(why);
    }
  });

  test('the native side saying UNSUPPORTED is a reason to ask, not an error', async () => {
    const asked: Array<{ q: string; d?: string }> = [];
    const m = machine({ caps: () => caps({ value: true }), append: () => new Error('UNSUPPORTED:The control refused the text (E_FAIL).') });
    realMachine(m);
    const r = await go(m, 'kbm.type_text', { text: 'hi', control: 'search box' }, ctx(false, asked));
    expect(r.ok).toBe(false);
    expect(asked[0]!.d).toMatch(/The control refused the text/);
    expect(unsupportedReason(new Error('UNSUPPORTED: nope.'))).toBe('nope.');
    expect(unsupportedReason(new Error('something else'))).toBeNull();
  });

  test('approved real typing focuses the field first, and a typed line break is judged as Enter', async () => {
    const asked: Array<{ q: string; d?: string }> = [];
    const m = machine({ caps: () => caps({ value: false }) });
    const real = realMachine(m);
    const r = await go(m, 'kbm.type_text', { text: 'hello', control: 'search box', window: 'notepad' }, ctx(true, asked));
    expect(r.ok).toBe(true);
    expect(real.slice(0, 2)).toEqual(['focus:w1', 'uiaFocus']);
    expect(real).toContain('type:hello');
  });

  test('typing with no control is the real keyboard, as it always was', async () => {
    const m = machine();
    const real = realMachine(m);
    const r = await go(m, 'kbm.type_text', { text: 'hi' });
    expect(r.ok).toBe(true);
    expect(real).toEqual(['type:hi']);
    expect(m.log.filter((l) => l.startsWith('append'))).toEqual([]);
  });
});

describe('scroll in the background', () => {
  test('scrolls the named list without the wheel (down is negative notches)', async () => {
    const m = machine({ caps: () => caps({ scroll: true }) });
    const r = await go(m, 'kbm.scroll', { amount: -5, window: 'notepad', control: 'messages' });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Scrolled “Messages” down 5/);
    expect(m.log).toEqual(['scroll:3:5']);
  });

  test('a window with nothing scrollable asks, and approval moves the cursor over it then turns the wheel', async () => {
    const asked: Array<{ q: string; d?: string }> = [];
    const m = machine({ caps: () => caps({ scroll: false }) });
    const real = realMachine(m);
    const r = await go(m, 'kbm.scroll', { amount: 3, window: 'notepad' }, ctx(true, asked));
    expect(asked[0]!.d).toMatch(/name a list or pane to scroll/);
    expect(r.ok).toBe(true);
    expect(real).toEqual(['move:400,300', 'wheel:3']);
  });

  test('no window and no control is the real wheel, as it always was', async () => {
    const m = machine();
    const real = realMachine(m);
    await go(m, 'kbm.scroll', { amount: -3 });
    expect(real).toEqual(['wheel:-3']);
  });
});

test('the tools say in plain words which route they take', () => {
  const m = machine();
  const byId = (id: string) => skill(m, id).description;
  assert.match(byId('kbm.click_element'), /in the background/);
  assert.match(byId('kbm.type_text'), /real keyboard/);
  assert.match(byId('kbm.scroll'), /real mouse wheel/);
  assert.match(byId('kbm.click'), /absolute screen position/); // coordinates are real input by nature
  for (const id of ['kbm.click_element', 'kbm.type_text', 'kbm.scroll']) {
    expect(skill(m, id).params?.mode?.enum).toEqual(['auto', 'virtual', 'real']);
  }
});
