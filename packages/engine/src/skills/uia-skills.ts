/**
 * UI Automation — operating another application's actual controls, ahead of
 * raw coordinates, because it acts on the control rather than guessing at
 * where it happens to be drawn.
 *
 * `path` crosses the wire as a comma-separated string of child indices
 * ("2,0,1", or "" for the root) rather than an array — `SkillParam` only
 * carries string/number/boolean, the same reason `input.hotkey` folds its
 * modifiers into one "ctrl+shift" string. `uia.tree`'s rows already show the
 * path each element needs, so the caller — almost always the AI planner,
 * reading what `uia.tree` just returned — copies it rather than typing it.
 *
 * Risk: reading the tree, and what's focused, are `safe`. Every action —
 * invoke, expand/collapse, set a value, type into a field — acts on another
 * application on your behalf and is `confirm`, the same test this whole
 * codebase applies everywhere else.
 */

import type { Platform, ResultRow, Skill, UiaNode } from '@atlas/core';
import { resolveWindow, liveWindows } from '../text/windows';

function parsePath(raw: unknown): number[] {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  return s
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

function nodeRow(node: UiaNode): ResultRow {
  return {
    title: node.name || node.role || '(unnamed)',
    subtitle: [node.role, `path ${node.path.length ? node.path.join(',') : '(root)'}`, node.enabled ? '' : 'disabled']
      .filter(Boolean)
      .join(' · '),
    icon: '🧩',
    payload: node,
  };
}

/** Every node in the tree, root first, depth-first — what a caller picks a `path` from. */
function flatten(node: UiaNode, out: UiaNode[] = []): UiaNode[] {
  out.push(node);
  for (const child of node.children) flatten(child, out);
  return out;
}

export function createUiaSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  /** The `{ id }` a window-targeting skill needs, or the response to hand straight back. */
  async function targetWindowId(
    query: string,
    ctx: { showResults?: (items: ResultRow[], meta?: { title?: string; subtitle?: string }) => void },
  ): Promise<{ id: string; title: string } | { early: { ok: boolean; message?: string; error?: string; spoken?: true } }> {
    const match = resolveWindow(await liveWindows(platform), query);
    if (match.kind === 'none') {
      return { early: { ok: false, error: `I can't find a window called "${query}".` } };
    }
    if (match.kind === 'many') {
      ctx.showResults?.(
        match.candidates.slice(0, 12).map((w) => ({ title: w.title, subtitle: w.processName, icon: '🪟', payload: w })),
        { title: `${match.candidates.length} windows match "${query}"`, subtitle: 'Say which one.' },
      );
      return { early: { ok: true, spoken: true, message: '' } };
    }
    return { id: match.entry.id, title: match.entry.title };
  }

  skills.push({
    id: 'uia.tree',
    label: 'Inspect a window',
    icon: '🧩',
    domain: 'system',
    description:
      "List a window's buttons, fields, menus and other controls, each with the path needed to act on it. Prefer this over screen coordinates.",
    needs: ['ui-automation', 'window-control'],
    risk: 'safe',
    examples: ['what controls does the notepad window have', 'inspect the notepad window'],
    params: {
      window: { type: 'string', required: true, description: 'the window, by its title or app name' },
      depth: { type: 'number', description: 'how many levels deep to walk (default 6)' },
    },
    async run(args, ctx) {
      const target = await targetWindowId(String(args.window ?? ''), ctx);
      if ('early' in target) return target.early;

      const depth = typeof args.depth === 'number' ? args.depth : undefined;
      const tree = await platform.uiaTree?.(target.id, depth);
      if (!tree) return { ok: false, error: `I couldn't inspect ${target.title}.` };

      const nodes = flatten(tree).filter((n) => n.name || n.role);
      ctx.showResults?.(nodes.slice(0, 200).map(nodeRow), {
        title: `${nodes.length} control${nodes.length === 1 ? '' : 's'} in ${target.title}`,
      });
      return { ok: true, spoken: true, message: '', data: tree };
    },
  });

  skills.push({
    id: 'uia.focusedElement',
    label: 'What has focus',
    icon: '🧩',
    domain: 'system',
    description: 'Describe whatever control currently has keyboard focus, system-wide.',
    needs: ['ui-automation'],
    risk: 'safe',
    examples: ['what control has focus'],
    async run() {
      const node = (await platform.uiaFocusedElement?.()) ?? null;
      if (!node) return { ok: true, message: "Nothing I can identify has focus right now." };
      return { ok: true, message: `${node.name || '(unnamed)'} — ${node.role}.`, data: node };
    },
  });

  skills.push({
    id: 'uia.invoke',
    label: 'Activate a control',
    icon: '🧩',
    domain: 'system',
    description:
      'Click, toggle or select a control found with uia.tree, by its window and path — whichever action pattern it actually supports.',
    needs: ['ui-automation', 'window-control'],
    // Acts on another application on your behalf.
    risk: 'confirm',
    examples: ['activate the save button in the notepad window'],
    params: {
      window: { type: 'string', required: true, description: 'the window, by its title or app name' },
      path: { type: 'string', description: 'the control\'s path from uia.tree, e.g. "2,0,1" (empty for the root)' },
    },
    async run(args, ctx) {
      const target = await targetWindowId(String(args.window ?? ''), ctx);
      if ('early' in target) return target.early;

      const ok = await platform.uiaInvoke?.(target.id, parsePath(args.path));
      if (!ok) return { ok: false, error: "That control didn't respond — it may not support being activated." };
      return { ok: true, message: `Activated it in ${target.title}.` };
    },
  });

  const setExpanded = (id: string, label: string, expand: boolean, examples: string[]): Skill => ({
    id,
    label,
    icon: '🧩',
    domain: 'system',
    description: `${label} a control found with uia.tree, by its window and path.`,
    needs: ['ui-automation', 'window-control'],
    risk: 'confirm',
    examples,
    params: {
      window: { type: 'string', required: true, description: 'the window, by its title or app name' },
      path: { type: 'string', description: 'the control\'s path from uia.tree' },
    },
    async run(args, ctx) {
      const target = await targetWindowId(String(args.window ?? ''), ctx);
      if ('early' in target) return target.early;
      const ok = await platform.uiaSetExpanded?.(target.id, parsePath(args.path), expand);
      if (!ok) return { ok: false, error: `That control doesn't ${expand ? 'expand' : 'collapse'}.` };
      return { ok: true, message: `${expand ? 'Expanded' : 'Collapsed'} it in ${target.title}.` };
    },
  });
  skills.push(setExpanded('uia.expand', 'Expand', true, ['expand the folders item in the explorer window']));
  skills.push(setExpanded('uia.collapse', 'Collapse', false, ['collapse the folders item in the explorer window']));

  skills.push({
    id: 'uia.setValue',
    label: 'Set a field’s value',
    icon: '🧩',
    domain: 'system',
    description:
      'Set a text field found with uia.tree directly, by its window and path — only works when the control supports it.',
    needs: ['ui-automation', 'window-control'],
    risk: 'confirm',
    examples: ['set the search field in the notepad window to hello'],
    params: {
      window: { type: 'string', required: true, description: 'the window, by its title or app name' },
      path: { type: 'string', description: 'the control\'s path from uia.tree' },
      value: { type: 'string', required: true, description: 'the text to set' },
    },
    async run(args, ctx) {
      const target = await targetWindowId(String(args.window ?? ''), ctx);
      if ('early' in target) return target.early;
      const ok = await platform.uiaSetValue?.(target.id, parsePath(args.path), String(args.value ?? ''));
      if (!ok) return { ok: false, error: "That control doesn't accept text directly." };
      return { ok: true, message: `Set it in ${target.title}.` };
    },
  });

  skills.push({
    id: 'uia.typeInto',
    label: 'Type into a field',
    icon: '🧩',
    domain: 'system',
    description:
      'Type text into a field found with uia.tree, by its window and path. Sets the value directly when the control supports it; otherwise focuses it and types, one keystroke at a time.',
    needs: ['ui-automation', 'window-control', 'input'],
    risk: 'confirm',
    examples: ['type "hello" into the search field in the notepad window'],
    params: {
      window: { type: 'string', required: true, description: 'the window, by its title or app name' },
      path: { type: 'string', description: 'the control\'s path from uia.tree' },
      text: { type: 'string', required: true, description: 'the text to type' },
    },
    async run(args, ctx) {
      const target = await targetWindowId(String(args.window ?? ''), ctx);
      if ('early' in target) return target.early;

      const path = parsePath(args.path);
      const text = String(args.text ?? '');

      const direct = await platform.uiaSetValue?.(target.id, path, text);
      if (direct) return { ok: true, message: `Typed into ${target.title}.` };

      const focused = await platform.uiaFocus?.(target.id, path);
      if (!focused) return { ok: false, error: "I couldn't reach that control at all." };
      const typed = await platform.typeText?.(text);
      if (!typed) return { ok: false, error: 'I focused it but the text failed to send.' };
      return { ok: true, message: `Typed into ${target.title}.` };
    },
  });

  return skills;
}
