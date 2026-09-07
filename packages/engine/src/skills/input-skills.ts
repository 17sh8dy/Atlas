/**
 * Synthetic mouse and keyboard — the fallback layer for when nothing more
 * semantic (a Windows API, a UI Automation call) can reach a control.
 *
 * Risk follows the same test as everywhere else in this codebase, and it
 * splits this pack cleanly in two: moving the cursor, reading where it is,
 * and scrolling are cosmetic and instantly reversible, so they're `safe`. A
 * click, a drag, a key press or typed text can do anything the target
 * application would let a human sitting at the keyboard do — there's no way
 * to know in advance whether "press enter" submits a form or confirms a
 * delete — so every one of those is `confirm`.
 */

import type { MouseButton, Platform, Skill } from '@atlas/core';

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
    // Whatever is under the cursor receives a real click — the same
    // consequence a human clicking there would cause.
    risk: 'confirm',
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
    risk: 'confirm',
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
    risk: 'confirm',
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
    risk: 'confirm',
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
    // Whatever has focus receives it — a terminal, a search box, a form —
    // and there's no way to know from here which of those it will be.
    risk: 'confirm',
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
