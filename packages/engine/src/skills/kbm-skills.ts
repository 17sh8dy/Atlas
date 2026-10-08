/**
 * `kbm.*` — keyboard and mouse control, as one named toolset.
 *
 * The same hands as `input.*` (synthetic mouse and keyboard through the
 * platform), with two things `input.*` did not have: names that say what they
 * do — `kbm.double_click`, `kbm.key_sequence` — and eyes. `kbm.get_active_window`
 * and `kbm.get_ui_elements` report what is on screen, with the centre of each
 * control, so a caller can click something it has actually seen rather than a
 * coordinate it guessed.
 *
 * ── Safe by what it lands on, not by what it is called ──────────────────────
 * Every click and every Enter/Space is checked before it happens (see
 * `safety/ui-target.ts`): a verified, harmless control goes ahead in Do It?; a
 * control that would pay, send, delete or install asks, naming it; and a spot
 * Atlas cannot identify asks too. An approval is therefore about the actual
 * target, never about a bare coordinate. Typing, scrolling and moving the mouse
 * change nothing by themselves and stay quiet — except that typing a line break
 * is Enter, and is judged like Enter.
 *
 * Alt+F4 stays `confirm`, in `kbm.hotkey` and inside a `kbm.key_sequence`,
 * exactly as it does in `input.hotkey`: it closes the foreground application.
 *
 * Nothing here can run a command. It has no argument that reaches a shell.
 *
 * ── Two ways to act: the background first (1.0.8) ───────────────────────────
 * A call that names a window or a control — `kbm.click_element`, `kbm.type_text` with a `control`,
 * `kbm.scroll` with a `window` — is done in the BACKGROUND whenever the app supports it: through the
 * window's own accessibility interface, so the person's cursor stays put and the window in front stays
 * in front. When the app can't do it that way, Atlas says why and ASKS before using the real mouse and
 * keyboard (`background-input.ts`); `mode: 'virtual'` never falls back and `mode: 'real'` goes
 * straight to the real ones. Coordinates (`kbm.click`), bare keys and hotkeys, and text with no
 * target are real input by their nature, and are described that way.
 */

import type {
  MouseButton,
  Platform,
  ResultRow,
  Skill,
  SkillArgs,
  SkillAssessment,
  SkillRisk,
  UiaNode,
  WindowEntry,
} from '@atlas/core';
import { assessControl } from '../safety/ui-consequence';
import {
  activatesFocused,
  assessFocused,
  assessPoint,
  probeTarget,
  type ClickKind,
} from '../safety/ui-target';
import { liveWindows, resolveWindow } from '../text/windows';
import { findControlByName } from './uia-skills';
import { performInput } from './input-verify';
import { MODE_PARAM, backgroundFirst, modeOf, type VirtualOutcome } from './background-input';

const NEEDS = ['input'] as const;
const ICON = '🖱️';

const INTERACTIVE =
  /^(button|menu item|menuitem|check box|checkbox|radio button|edit|combo box|combobox|link|hyperlink|list item|tab item|slider|split button|toggle|spinner)$/;

function closesApp(combo: string): boolean {
  return (
    combo
      .toLowerCase()
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean)
      .sort()
      .join('+') === 'alt+f4'
  );
}

/** One token of a key sequence. */
type Token = { kind: 'text'; text: string } | { kind: 'combo'; combo: string };

/**
 * "ctrl+a, delete, type:hello, enter" → tokens. A `type:` token runs to the next
 * comma, so text that needs a comma is typed with `kbm.type_text` instead.
 */
export function parseSequence(raw: string): Token[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) =>
      /^type:/i.test(t) ? { kind: 'text', text: t.slice(5) } : { kind: 'combo', combo: t },
    );
}

const centre = (n: UiaNode) => ({
  x: Math.round(n.x + n.width / 2),
  y: Math.round(n.y + n.height / 2),
});

export function createKbmSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  // ── Clicks ────────────────────────────────────────────────────────────────

  const clickSkill = (
    id: string,
    label: string,
    verb: ClickKind,
    button: MouseButton,
    double: boolean,
  ): Skill => ({
    id,
    label,
    icon: ICON,
    domain: 'system',
    description: `${label} at an absolute screen position. Checked first: Atlas looks at what is at that spot and asks if it would pay, send, delete or install, or if it cannot tell.`,
    needs: NEEDS,
    risk: 'safe',
    params: {
      x: { type: 'number', required: true, description: 'x position, in pixels' },
      y: { type: 'number', required: true, description: 'y position, in pixels' },
    },
    assess: (args) => assessPoint(platform, Number(args.x), Number(args.y), verb),
    async run(args) {
      return performInput({
        platform,
        label: `${label} at ${args.x}, ${args.y}`,
        failure: "I couldn't click there.",
        send: () =>
          platform.mouseClick?.(Number(args.x), Number(args.y), button, double) as Promise<
            boolean | undefined
          >,
      });
    },
  });

  skills.push(clickSkill('kbm.click', 'Click', 'Click', 'left', false));
  skills.push(clickSkill('kbm.double_click', 'Double-click', 'Double-click', 'left', true));
  skills.push(clickSkill('kbm.right_click', 'Right-click', 'Right-click', 'right', false));
  skills.push(clickSkill('kbm.middle_click', 'Middle-click', 'Middle-click', 'middle', false));

  skills.push({
    id: 'kbm.drag',
    label: 'Drag',
    icon: ICON,
    domain: 'system',
    description:
      'Press the mouse down at one position, drag to another and release. Both ends are checked first.',
    needs: NEEDS,
    risk: 'safe',
    params: {
      fromX: { type: 'number', required: true, description: 'starting x position' },
      fromY: { type: 'number', required: true, description: 'starting y position' },
      toX: { type: 'number', required: true, description: 'ending x position' },
      toY: { type: 'number', required: true, description: 'ending y position' },
    },
    async assess(args) {
      // What is grabbed, and where it is dropped: a drop onto the Recycle Bin
      // or a "Send" target is the consequence, not the grab.
      const from = await assessPoint(platform, Number(args.fromX), Number(args.fromY), 'Drag from');
      if (from.kind !== 'routine') return from;
      const to = await assessPoint(platform, Number(args.toX), Number(args.toY), 'Click');
      if (to.kind === 'refuse') return to;
      if (to.kind === 'ask') {
        return {
          kind: 'ask',
          question: `Drag from ${args.fromX}, ${args.fromY} and drop at ${args.toX}, ${args.toY}?`,
          detail: `Where it would be dropped: ${to.detail}`,
        };
      }
      return { kind: 'routine' };
    },
    async run(args) {
      return performInput({
        platform,
        label: `Dragged to ${args.toX}, ${args.toY}`,
        failure: "I couldn't drag that.",
        send: () =>
          platform.mouseDrag?.(
            Number(args.fromX),
            Number(args.fromY),
            Number(args.toX),
            Number(args.toY),
            'left',
          ) as Promise<boolean | undefined>,
      });
    },
  });

  // ── Reading the screen, so a click can be aimed at something seen ───────────

  skills.push({
    id: 'kbm.move_mouse',
    label: 'Move the mouse',
    icon: ICON,
    domain: 'system',
    description: 'Move the mouse cursor to an absolute screen position.',
    needs: NEEDS,
    risk: 'safe',
    params: {
      x: { type: 'number', required: true, description: 'x position, in pixels' },
      y: { type: 'number', required: true, description: 'y position, in pixels' },
    },
    async run(args) {
      const ok = await platform.moveMouse?.(Number(args.x), Number(args.y));
      if (!ok) return { ok: false, error: "I couldn't move the mouse." };
      return { ok: true, message: `Moved the mouse to ${args.x}, ${args.y}.` };
    },
  });

  skills.push({
    id: 'kbm.get_cursor_position',
    label: 'Where the mouse is',
    icon: ICON,
    domain: 'system',
    description: 'The current mouse cursor position.',
    needs: NEEDS,
    risk: 'safe',
    async run() {
      const pos = await platform.cursorPosition?.();
      if (!pos) return { ok: false, error: "I couldn't read the cursor position." };
      return { ok: true, message: `${pos.x}, ${pos.y}`, data: pos };
    },
  });

  skills.push({
    id: 'kbm.scroll',
    label: 'Scroll',
    icon: ICON,
    domain: 'system',
    description:
      'Scroll. Positive scrolls up, negative scrolls down. With a `window` and/or `control` it scrolls that area in the background (your mouse and the window in front are not touched), and asks before using the real mouse wheel if the app can\'t; with neither it turns the real mouse wheel over whatever is under the cursor.',
    needs: NEEDS,
    risk: 'safe',
    params: {
      amount: {
        type: 'number',
        default: -3,
        description: 'notches; positive is up, negative is down',
      },
      window: { type: 'string', required: false, description: 'the window to scroll in the background' },
      control: { type: 'string', required: false, description: 'the list, page or pane by name (default: the whole window)' },
      mode: MODE_PARAM,
    },
    async run(args, ctx) {
      const amount = Number(args.amount ?? -3);
      const realScroll = async () => {
        const ok = await platform.mouseScroll?.(amount);
        if (!ok) return { ok: false as const, error: "I couldn't scroll." };
        return { ok: true as const, message: 'Scrolled.' };
      };
      // No target named: this has always been the real wheel, and still is.
      if (!args.window && !args.control) return realScroll();

      const win = await targetWindow(args.window);
      if ('error' in win) return { ok: false, error: win.error };
      let path: number[] = [];
      let what = win.title;
      let over = { x: Math.round(win.x + win.width / 2), y: Math.round(win.y + win.height / 2) };
      if (args.control) {
        const found = await resolveElement(args);
        if ('error' in found) return { ok: false, error: found.error };
        path = found.node.path;
        what = `“${found.node.name}”`;
        over = found.at;
      }
      return backgroundFirst({
        mode: modeOf(args.mode),
        ctx,
        what: `scroll ${what}`,
        windowTitle: win.title,
        realEffect: `move your cursor over ${what} and turn the mouse wheel`,
        async virtual(): Promise<VirtualOutcome> {
          if (!platform.uiaCapabilities || !platform.uiaScroll) return { kind: 'unsupported', reason: 'this build can’t scroll without the mouse wheel' };
          const caps = await platform.uiaCapabilities(win.id, path);
          if (!caps.scroll) {
            return { kind: 'unsupported', reason: `${what} can’t be scrolled without the mouse wheel${args.control ? '' : ' — name a list or pane to scroll'}` };
          }
          // Skill notches are positive-up; the accessibility interface is positive-down.
          await platform.uiaScroll(win.id, path, -amount, 0);
          return { kind: 'done', message: `Scrolled ${what} ${amount < 0 ? 'down' : 'up'} ${Math.abs(amount)}.`, data: { input: 'sent' } };
        },
        real: async () => {
          await platform.moveMouse?.(over.x, over.y);
          return realScroll();
        },
      });
    },
  });

  skills.push({
    id: 'kbm.get_active_window',
    label: 'The active window',
    icon: '🪟',
    domain: 'system',
    description: 'Which window is in front right now: its title, app and position on screen.',
    needs: ['windows'],
    risk: 'safe',
    async run() {
      const win = await platform.activeWindow?.();
      if (!win) return { ok: true, message: 'No window is active right now.' };
      return {
        ok: true,
        message: `${win.title || '(untitled)'} — ${win.processName}, ${win.width}×${win.height} at ${win.x}, ${win.y}.`,
        data: win,
      };
    },
  });

  /** The window a caller means: the one named, or the active one. */
  async function targetWindow(query: unknown): Promise<WindowEntry | { error: string }> {
    const wanted = String(query ?? '').trim();
    if (!wanted) {
      const active = await platform.activeWindow?.();
      return active ?? { error: 'No window is active, and none was named.' };
    }
    const match = resolveWindow(await liveWindows(platform), wanted);
    if (match.kind === 'none') return { error: `I can't find a window called "${wanted}".` };
    if (match.kind === 'many') {
      return { error: `More than one window matches "${wanted}" — say which.` };
    }
    return match.entry;
  }

  skills.push({
    id: 'kbm.get_ui_elements',
    label: 'What is on screen',
    icon: '🧩',
    domain: 'system',
    description:
      'List the buttons, fields, menus and links in a window (the active one by default), each with its name, role and the centre coordinates to click. Read this before clicking so the click lands on something Atlas has seen.',
    needs: ['ui-automation', 'windows'],
    risk: 'safe',
    params: {
      window: {
        type: 'string',
        description: 'the window, by title or app name — omit for the active window',
      },
      all: {
        type: 'boolean',
        default: false,
        description: 'include labels and containers, not just things you can operate',
      },
    },
    async run(args, ctx) {
      const win = await targetWindow(args.window);
      if ('error' in win) return { ok: false, error: win.error };
      const tree = await platform.uiaTree?.(win.id);
      if (!tree) return { ok: false, error: `I couldn't read the controls in ${win.title}.` };

      const all: UiaNode[] = [];
      const walk = (n: UiaNode) => {
        all.push(n);
        n.children.forEach(walk);
      };
      walk(tree);

      const wantAll = args.all === true;
      const shown = all
        .filter((n) => n.width > 0 && n.height > 0 && (n.name.trim() || n.automationId))
        .filter((n) => wantAll || INTERACTIVE.test(n.role))
        .slice(0, 250);

      const elements = shown.map((n) => ({
        name: n.name,
        role: n.role,
        automationId: n.automationId,
        enabled: n.enabled,
        ...centre(n),
        width: n.width,
        height: n.height,
      }));

      const rows: ResultRow[] = shown.map((n, i) => ({
        title: n.name || n.automationId || n.role,
        subtitle: `${n.role} · click at ${elements[i]!.x}, ${elements[i]!.y}${n.enabled ? '' : ' · disabled'}`,
        icon: '🧩',
        payload: elements[i],
      }));
      ctx.showResults?.(rows, {
        title: `${rows.length} control${rows.length === 1 ? '' : 's'} in ${win.title}`,
      });
      return { ok: true, spoken: true, message: '', data: { window: win.title, elements } };
    },
  });

  /** Find a control by name and where to click it, or say why not. */
  async function resolveElement(args: SkillArgs) {
    const win = await targetWindow(args.window);
    if ('error' in win) return { error: win.error };
    const tree = await platform.uiaTree?.(win.id);
    if (!tree) return { error: `I couldn't read the controls in ${win.title}.` };
    const node = findControlByName(tree, String(args.control ?? ''));
    if (!node)
      return {
        error: `I can't find a control called “${String(args.control ?? '')}” in ${win.title}.`,
      };
    if (!node.enabled) return { error: `“${node.name}” is there, but greyed out.` };
    if (node.width <= 0 || node.height <= 0) {
      return { error: `“${node.name}” has no size on screen, so I can't click it.` };
    }
    return { win, tree, node, at: centre(node) };
  }

  skills.push({
    id: 'kbm.click_element',
    label: 'Click a control by name',
    icon: ICON,
    domain: 'system',
    description:
      'Find a control by its name in a window (the active one by default) and press it. By default this is done in the background through the window\'s accessibility interface, without moving your mouse or changing the window in front; if the app does not support that, Atlas says why and asks before using the real mouse to click its centre. Checked first, like any click.',
    needs: ['input', 'ui-automation', 'windows'],
    risk: 'safe',
    params: {
      control: { type: 'string', required: true, description: 'the control by name, e.g. "save"' },
      window: {
        type: 'string',
        description: 'the window, by title or app name — omit for the active window',
      },
      double: { type: 'boolean', default: false, description: 'double-click instead (needs the real mouse)' },
      mode: MODE_PARAM,
    },
    async assess(args): Promise<SkillAssessment> {
      const found = await resolveElement(args);
      if ('error' in found) return { kind: 'routine' }; // `run` says why it can't
      const refused = await probeTarget(platform, { windowId: found.win.id });
      if (refused) return refused;
      const verdict = assessControl({
        root: found.tree,
        node: found.node,
        windowTitle: found.win.title,
      });
      if (verdict.kind === 'routine') return verdict;
      return {
        kind: 'ask',
        question: `Click “${found.node.name}” (${found.node.role}) in ${found.win.title}?`,
        detail: `I checked what it does before clicking: ${verdict.reason}.`,
      };
    },
    async run(args, ctx) {
      const found = await resolveElement(args);
      if ('error' in found) return { ok: false, error: found.error };
      const double = args.double === true;
      const label = `“${found.node.name}”`;
      return backgroundFirst({
        mode: modeOf(args.mode),
        ctx,
        what: `press ${label}`,
        windowTitle: found.win.title,
        realEffect: `move your cursor onto ${label} and ${double ? 'double-click' : 'click'} it`,
        async virtual(): Promise<VirtualOutcome> {
          if (double) return { kind: 'unsupported', reason: 'a double-click needs the real mouse' };
          if (!platform.uiaCapabilities || !platform.uiaInvoke) {
            return { kind: 'unsupported', reason: 'this build can’t check what that control supports' };
          }
          const caps = await platform.uiaCapabilities(found.win.id, found.node.path);
          if (caps.offscreen) return { kind: 'unsupported', reason: `${label} is scrolled out of view` };
          if (!caps.invoke && !caps.toggle && !caps.select) {
            return { kind: 'unsupported', reason: `${label} (${caps.role || found.node.role}) can’t be pressed without the mouse` };
          }
          const ok = await platform.uiaInvoke(found.win.id, found.node.path);
          if (!ok) return { kind: 'failed', error: `The app didn’t accept the press on ${label}.` };
          return { kind: 'done', message: `Pressed ${label} in ${found.win.title}.`, data: { input: 'sent', control: found.node.name } };
        },
        real: () =>
          performInput({
            platform,
            label: `Clicked ${label} in ${found.win.title}`,
            failure: "I couldn't click there.",
            send: () => platform.mouseClick?.(found.at.x, found.at.y, 'left', double) as Promise<boolean | undefined>,
          }),
      });
    },
  });

  // ── Keys ──────────────────────────────────────────────────────────────────

  skills.push({
    id: 'kbm.press_key',
    label: 'Press a key',
    icon: '⌨️',
    domain: 'system',
    description:
      'Press one named key — enter, tab, escape, backspace, delete, an arrow key, home, end, page up/down, space, or f1 through f12. Enter and space press whatever has focus, so they are checked first.',
    needs: NEEDS,
    risk: 'safe',
    params: { key: { type: 'string', required: true, description: 'the key name' } },
    assess: async (args) =>
      activatesFocused(String(args.key ?? ''))
        ? assessFocused(platform, String(args.key))
        : { kind: 'routine' },
    async run(args) {
      const key = String(args.key ?? '');
      return performInput({
        platform,
        label: `Pressed ${key}`,
        failure: `I don't know a key called "${key}", or pressing it failed.`,
        send: () => platform.pressKey?.(key) as Promise<boolean | undefined>,
      });
    },
  });

  skills.push({
    id: 'kbm.hotkey',
    label: 'Press a key combination',
    icon: '⌨️',
    domain: 'system',
    description:
      'Press a key combination such as "ctrl+c" or "ctrl+shift+s" — modifiers joined to one key with "+". Alt+F4 asks first; a combination with Enter in it is checked like Enter.',
    needs: NEEDS,
    risk: 'safe',
    riskFor: (args): SkillRisk | undefined =>
      closesApp(String(args.combo ?? '')) ? 'confirm' : undefined,
    params: {
      combo: { type: 'string', required: true, description: 'e.g. "ctrl+c" or "ctrl+alt+t"' },
    },
    assess: async (args) =>
      activatesFocused(String(args.combo ?? ''))
        ? assessFocused(platform, String(args.combo))
        : { kind: 'routine' },
    async run(args) {
      const parts = String(args.combo ?? '')
        .split('+')
        .map((p) => p.trim())
        .filter(Boolean);
      const key = parts.pop();
      if (!key) return { ok: false, error: 'That combination has no key in it.' };
      return performInput({
        platform,
        label: `Pressed ${args.combo}`,
        failure: `I couldn't send ${args.combo}.`,
        send: () => platform.hotkey?.(parts, key) as Promise<boolean | undefined>,
      });
    },
  });

  skills.push({
    id: 'kbm.type_text',
    label: 'Type text',
    icon: '⌨️',
    domain: 'system',
    description:
      'Type text. With a `control` (and optionally a `window`) the text is added to that field in the background — your keyboard, mouse and the window in front are not touched; if the app can\'t take text that way, Atlas says why and asks before using the real keyboard. With no control it types into whatever currently has keyboard focus, using the real keyboard. A line break in the text is an Enter and is checked like one.',
    needs: NEEDS,
    risk: 'safe',
    params: {
      text: { type: 'string', required: true, description: 'the text to type' },
      control: { type: 'string', required: false, description: 'the text field by name, to type into it in the background' },
      window: { type: 'string', required: false, description: 'the window the field is in (default: the active window)' },
      mode: MODE_PARAM,
    },
    assess: async (args) =>
      // A named field is typed into in the background, where a line break is just a character it
      // either accepts or doesn't; the Enter check belongs to the real keyboard, below.
      /[\r\n]/.test(String(args.text ?? '')) && !(args.control && modeOf(args.mode) !== 'real')
        ? assessFocused(platform, 'Enter')
        : { kind: 'routine' },
    async run(args, ctx) {
      const text = String(args.text ?? '');
      if (!text) return { ok: false, error: "There's nothing to type." };
      if (args.control) {
        const found = await resolveElement(args);
        if ('error' in found) return { ok: false, error: found.error };
        const where = `“${found.node.name}” in ${found.win.title}`;
        return backgroundFirst({
          mode: modeOf(args.mode),
          ctx,
          what: `type into ${where}`,
          windowTitle: found.win.title,
          realEffect: `bring ${found.win.title} to the front, click ${found.node.name ? `“${found.node.name}”` : 'the field'} and type with your keyboard`,
          async virtual(): Promise<VirtualOutcome> {
            if (/[\r\n]/.test(text)) return { kind: 'unsupported', reason: 'a line break needs the Enter key' };
            if (!platform.uiaCapabilities || !platform.uiaAppendValue) {
              return { kind: 'unsupported', reason: 'this build can’t type into a field without the keyboard' };
            }
            const caps = await platform.uiaCapabilities(found.win.id, found.node.path);
            if (caps.password) return { kind: 'unsupported', reason: 'that is a password field (or one I can’t tell about), and I never type into those in the background' };
            if (!caps.value) return { kind: 'unsupported', reason: `${where} doesn’t accept text without the keyboard` };
            if (caps.valueReadOnly) return { kind: 'unsupported', reason: `${where} is read-only` };
            const typed = await platform.uiaAppendValue(found.win.id, found.node.path, text);
            if (!typed.verified) {
              return { kind: 'failed', error: `I added the text to ${where}, but reading the field back doesn’t show exactly that — I’m not calling it done.` };
            }
            return {
              kind: 'done',
              message: `Typed ${text.length} character${text.length === 1 ? '' : 's'} into ${where} — verified by reading the field back.`,
              data: { input: 'verified', charsBefore: typed.charsBefore, charsAfter: typed.charsAfter },
            };
          },
          async real() {
            // The real keyboard types into whatever has focus, so first put focus on the field …
            await platform.focusWindow?.(found.win.id);
            await platform.uiaFocus?.(found.win.id, found.node.path);
            // … and a line break is an Enter, judged by the control that now has focus.
            if (/[\r\n]/.test(text)) {
              const verdict = await assessFocused(platform, 'Enter');
              if (verdict.kind === 'refuse') return { ok: false, error: verdict.message };
              if (verdict.kind === 'ask' && !(await ctx.confirm(verdict.question, verdict.detail))) {
                return { ok: false, error: 'You said no, so I left it alone — nothing was typed.' };
              }
            }
            return performInput({
              platform,
              label: (secret) => (secret ? `Typed ${text.length} characters (hidden — password field)` : `Typed “${text.length > 60 ? `${text.slice(0, 57)}…` : text}”`),
              failure: "I couldn't type that.",
              typed: text,
              send: () => platform.typeText?.(text) as Promise<boolean | undefined>,
            });
          },
        });
      }
      return performInput({
        platform,
        label: (secret) =>
          secret
            ? `Typed ${text.length} character${text.length === 1 ? '' : 's'} (hidden — password field)`
            : `Typed “${text.length > 60 ? `${text.slice(0, 57)}…` : text}”`,
        failure: "I couldn't type that.",
        typed: text,
        send: () => platform.typeText?.(text) as Promise<boolean | undefined>,
      });
    },
  });

  skills.push({
    id: 'kbm.key_sequence',
    label: 'Press a sequence of keys',
    icon: '⌨️',
    domain: 'system',
    description:
      'Press several keys in order, separated by commas: "ctrl+a, delete, type:hello, enter". A token starting with "type:" types the text after it. Focus can change between keys, so an Enter that is not first is always asked about.',
    needs: NEEDS,
    risk: 'safe',
    riskFor: (args): SkillRisk | undefined =>
      parseSequence(String(args.sequence ?? '')).some(
        (t) => t.kind === 'combo' && closesApp(t.combo),
      )
        ? 'confirm'
        : undefined,
    params: {
      sequence: {
        type: 'string',
        required: true,
        description: 'e.g. "ctrl+l, type:example.com, enter"',
      },
    },
    async assess(args): Promise<SkillAssessment> {
      const tokens = parseSequence(String(args.sequence ?? ''));
      const isActivating = (t: Token) =>
        t.kind === 'combo' ? activatesFocused(t.combo) : /[\r\n]/.test(t.text);
      const firstIndex = tokens.findIndex(isActivating);
      if (firstIndex === -1) return { kind: 'routine' };
      // Only an Enter that comes first is pressing the control that has focus
      // now. After any other key the focus may have moved, and Atlas cannot see
      // where — so it asks, and shows the whole sequence.
      if (firstIndex === 0) return assessFocused(platform, 'Enter');
      return {
        kind: 'ask',
        question: 'Press this sequence of keys?',
        detail: `${String(args.sequence)} — it includes Enter after other keys, and I cannot tell in advance what will have focus by then.`,
      };
    },
    async run(args) {
      const tokens = parseSequence(String(args.sequence ?? ''));
      if (tokens.length === 0) return { ok: false, error: 'That sequence has no keys in it.' };
      let stoppedAt = '';
      const texts = tokens.filter((t): t is Extract<Token, { kind: 'text' }> => t.kind === 'text');
      const result = await performInput({
        platform,
        label: `Pressed ${tokens.length} key${tokens.length === 1 ? '' : 's'} in order`,
        failure: 'That sequence could not be sent.',
        // Only a lone typed string can be looked for afterwards.
        typed: texts.length === 1 ? texts[0]!.text : undefined,
        send: async () => {
          for (const [i, token] of tokens.entries()) {
            let ok: boolean | undefined;
            if (token.kind === 'text') {
              ok = await platform.typeText?.(token.text);
            } else {
              const parts = token.combo
                .split('+')
                .map((p) => p.trim())
                .filter(Boolean);
              const key = parts.pop();
              ok = key
                ? parts.length
                  ? await platform.hotkey?.(parts, key)
                  : await platform.pressKey?.(key)
                : false;
            }
            if (!ok) {
              stoppedAt = `Stopped at step ${i + 1} of ${tokens.length}: I couldn't send “${token.kind === 'text' ? `type:${token.text}` : token.combo}”.`;
              return false;
            }
          }
          return true;
        },
      });
      return stoppedAt && !result.ok ? { ...result, error: stoppedAt } : result;
    },
  });

  return skills;
}

/** Args re-exported for tests that build a call by hand. */
export type KbmArgs = SkillArgs;
