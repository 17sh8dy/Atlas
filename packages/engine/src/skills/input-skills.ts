/**
 * Synthetic mouse and keyboard — the fallback layer for when nothing more
 * semantic (a Windows API, a UI Automation call) can reach a control.
 *
 * ── Risk is about consequence, not mechanism ─────────────────────────────
 * A click, a key press and typed text are how this pack acts, not what it
 * does — the same distinction that already makes `window.focus` `safe` and
 * `window.close` `confirm` despite both being "operate a window". Clicking,
 * pressing a key and typing text are `safe` here for the same reason: the
 * overwhelming majority of them — "press enter", "click play", "type this
 * sentence" — submit, activate or enter something with nothing left to undo
 * once you've done it once by hand, and asking "are you sure?" before *every*
 * one of them (Phase 12's original call) protected nothing: the card could
 * only ever show a coordinate or a key name, never what was actually behind
 * it, so a person approving it knew exactly as much as Atlas did. Real
 * protection against something destructive already lives where it always
 * has — in the *named* skill for that thing (`window.close`, `files.delete`,
 * `system.emptyRecycleBin`, `system.endProcess`), not in gating the generic
 * hands underneath all of them.
 *
 * The one case where a raw *mechanism* is a known equivalent of an already-
 * gated *named* action gets escalated specifically rather than by making the
 * whole skill ask again: `input.hotkey`'s `riskFor` treats Alt+F4 as
 * `confirm`, because it closes the foreground application exactly the way
 * `window.close` does — see that skill for why blanket caution isn't the
 * only way to keep the protection `window.close` already provides.
 *
 * See `docs/ARCHITECTURE.md` §6.6 for the fuller reasoning and the decision
 * record of what this replaced.
 */

import type { MouseButton, Platform, Skill, SkillRisk } from '@atlas/core';

/**
 * The one hotkey this pack still asks about, however it's spelled — the
 * modifier order and case a person types shouldn't matter to whether closing
 * the foreground app asks first.
 */
function isCloseAppHotkey(combo: unknown): boolean {
  const parts = String(combo ?? '')
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .sort();
  return parts.join('+') === 'alt+f4';
}

const BUTTONS: readonly MouseButton[] = ['left', 'right', 'middle'];

function asButton(value: unknown): MouseButton {
  return typeof value === 'string' && (BUTTONS as readonly string[]).includes(value)
    ? (value as MouseButton)
    : 'left';
}

export function createInputSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'input.moveMouse',
    label: 'Move the mouse',
    icon: '🖱️',
    domain: 'system',
    description: 'Move the mouse cursor to an absolute screen position.',
    needs: ['input'],
    risk: 'safe',
    examples: ['move the mouse to 500, 300'],
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
    id: 'input.cursorPosition',
    label: 'Where the mouse is',
    icon: '🖱️',
    domain: 'system',
    description: 'The current mouse cursor position.',
    needs: ['input'],
    risk: 'safe',
    examples: ['where is the mouse'],
    async run() {
      const pos = await platform.cursorPosition?.();
      if (!pos) return { ok: false, error: "I couldn't read the cursor position." };
      return { ok: true, message: `${pos.x}, ${pos.y}`, data: pos };
    },
  });

  skills.push({
    id: 'input.click',
    label: 'Click',
    icon: '🖱️',
    domain: 'system',
    description: 'Click, right-click or double-click at an absolute screen position.',
    needs: ['input'],
    // A click is a mechanism, not a consequence — see the file doc comment.
    risk: 'safe',
    examples: ['click at 500, 300', 'double-click at 500, 300', 'right-click at 500, 300'],
    params: {
      x: { type: 'number', required: true, description: 'x position, in pixels' },
      y: { type: 'number', required: true, description: 'y position, in pixels' },
      button: { type: 'string', enum: BUTTONS, default: 'left', description: 'which button' },
      double: { type: 'boolean', default: false, description: 'double-click instead of a single click' },
    },
    async run(args) {
      const ok = await platform.mouseClick?.(
        Number(args.x),
        Number(args.y),
        asButton(args.button),
        args.double === true,
      );
      if (!ok) return { ok: false, error: "I couldn't click there." };
      return { ok: true, message: `Clicked at ${args.x}, ${args.y}.` };
    },
  });

  skills.push({
    id: 'input.scroll',
    label: 'Scroll',
    icon: '🖱️',
    domain: 'system',
    description: 'Scroll the mouse wheel. Positive scrolls up, negative scrolls down.',
    needs: ['input'],
    risk: 'safe',
    examples: ['scroll down', 'scroll up 3'],
    params: {
      amount: { type: 'number', default: -3, description: 'notches; positive is up, negative is down' },
    },
    async run(args) {
      const ok = await platform.mouseScroll?.(Number(args.amount ?? -3));
      if (!ok) return { ok: false, error: "I couldn't scroll." };
      return { ok: true, message: 'Scrolled.' };
    },
  });

  skills.push({
    id: 'input.drag',
    label: 'Drag',
    icon: '🖱️',
    domain: 'system',
    description: 'Press the mouse down at one position, drag to another, then release.',
    needs: ['input'],
    risk: 'safe',
    examples: ['drag from 100, 100 to 400, 400'],
    params: {
      fromX: { type: 'number', required: true, description: 'starting x position' },
      fromY: { type: 'number', required: true, description: 'starting y position' },
      toX: { type: 'number', required: true, description: 'ending x position' },
      toY: { type: 'number', required: true, description: 'ending y position' },
      button: { type: 'string', enum: BUTTONS, default: 'left', description: 'which button to hold' },
    },
    async run(args) {
      const ok = await platform.mouseDrag?.(
        Number(args.fromX),
        Number(args.fromY),
        Number(args.toX),
        Number(args.toY),
        asButton(args.button),
      );
      if (!ok) return { ok: false, error: "I couldn't drag that." };
      return { ok: true, message: `Dragged to ${args.toX}, ${args.toY}.` };
    },
  });

  skills.push({
    id: 'input.pressKey',
    label: 'Press a key',
    icon: '⌨️',
    domain: 'system',
    description:
      'Press one named key — enter, tab, escape, backspace, delete, an arrow key, home, end, page up/down, space, or f1 through f12.',
    needs: ['input'],
    risk: 'safe',
    examples: ['press enter', 'press escape', 'press tab'],
    params: {
      key: { type: 'string', required: true, description: 'the key name' },
    },
    async run(args) {
      const key = String(args.key ?? '');
      const ok = await platform.pressKey?.(key);
      if (!ok) return { ok: false, error: `I don't know a key called "${key}", or pressing it failed.` };
      return { ok: true, message: `Pressed ${key}.` };
    },
  });

  skills.push({
    id: 'input.hotkey',
    label: 'Press a key combination',
    icon: '⌨️',
    domain: 'system',
    description:
      'Press a key combination such as "ctrl+c" or "ctrl+shift+s" — modifiers joined to one key with "+".',
    needs: ['input'],
    risk: 'safe',
    // Alt+F4 closes the foreground application — the same consequence
    // `window.close` already asks about, just reached by a different
    // mechanism. Escalating this one combination is what keeps that
    // protection real without making every other hotkey ask "are you sure"
    // on its account. See the file doc comment.
    riskFor: (args): SkillRisk | undefined => (isCloseAppHotkey(args.combo) ? 'confirm' : undefined),
    examples: ['press ctrl+c', 'press ctrl+shift+s'],
    params: {
      combo: { type: 'string', required: true, description: 'e.g. "ctrl+c" or "ctrl+alt+t"' },
    },
    async run(args) {
      const parts = String(args.combo ?? '')
        .split('+')
        .map((p) => p.trim())
        .filter(Boolean);
      const key = parts.pop();
      if (!key) return { ok: false, error: 'That combination has no key in it.' };

      const ok = await platform.hotkey?.(parts, key);
      if (!ok) return { ok: false, error: `I couldn't send ${args.combo}.` };
      return { ok: true, message: `Pressed ${args.combo}.` };
    },
  });

  skills.push({
    id: 'input.typeText',
    label: 'Type text',
    icon: '⌨️',
    domain: 'system',
    description: 'Type text into whatever currently has keyboard focus.',
    needs: ['input'],
    // Typing is a mechanism, not a consequence — see the file doc comment.
    risk: 'safe',
    examples: ['type "hello there"'],
    params: {
      text: { type: 'string', required: true, description: 'the text to type' },
    },
    async run(args) {
      const text = String(args.text ?? '');
      if (!text) return { ok: false, error: "There's nothing to type." };
      const ok = await platform.typeText?.(text);
      if (!ok) return { ok: false, error: "I couldn't type that." };
      return { ok: true, message: 'Typed.' };
    },
  });

  return skills;
}
