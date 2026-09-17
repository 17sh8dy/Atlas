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
 * ── Risk is about consequence, not mechanism ─────────────────────────────
 * Reading the tree and what's focused are `safe`, unsurprisingly. So is every
 * action — invoke, expand/collapse, set a value, type into a field — for the
 * same reason `input.click`/`pressKey`/`typeText` are (see that file's doc
 * comment): activating a control, typing into a field or opening a tree node
 * are mechanisms, and the overwhelming majority of them have nothing left to
 * undo once they've happened. UIA is explicitly the *more* precise way to do
 * these things — it acts on a named control rather than a coordinate — so it
 * would be backwards for it to ask more often than the raw-input fallback it
 * exists to be preferred over.
 *
 * What still protects the genuinely consequential case is unchanged: a
 * *named* skill for that thing (`window.close`, `files.delete`,
 * `system.emptyRecycleBin`) stays `confirm` regardless of whether Atlas
 * reaches it through its own Rust command or, one day, by walking a UI tree
 * to press the same button by hand. Nothing here gates *that* — this file
 * only ever operates a control that isn't already one of Atlas's own,
 * validated actions.
 */

import type { Platform, ResultRow, Skill, SkillArgs, UiaNode } from '@atlas/core';
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

/**
 * A control named the way a person would name it — "the save button" — rather
 * than by the index path `uia.tree` prints.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every skill in this file used to take `path` and nothing else, on the
 * reasoning that the caller is "almost always the AI planner, reading what
 * `uia.tree` just returned". Two things were wrong with that. Atlas is built
 * to be fully useful with no provider connected, so "almost always" left the
 * whole pack unreachable on a machine with none. And every one of these
 * skills advertised an example — "activate the save button in the notepad
 * window" — that named a control, which `path` could never accept. The
 * capability list was describing a feature that did not exist.
 *
 * `path` still works and still wins when given: a path is exact, and a caller
 * that already walked the tree should not be second-guessed by a name search.
 *
 * ── How a name is matched ───────────────────────────────────────────────────
 * Four passes, most specific first, so that a precise name is never beaten by
 * a loose match on something else:
 *
 *  1. exact name, case-insensitively — "Save" is `Save`;
 *  2. exact `automationId`, which is what an app's own author called it;
 *  3. name ignoring an access-key ampersand and a trailing ellipsis, so
 *     "&Save As..." answers to "save as" — Windows menus are full of these;
 *  4. name containing the query, as a last resort.
 *
 * Within a pass, an *enabled* control wins over a disabled one (a greyed-out
 * "Save" is not what "click save" meant), and then the earliest in the tree.
 * A trailing role word is dropped first — "the save button" is a search for
 * "save" — and a leading article with it.
 */
const ROLE_WORDS = [
  'button', 'item', 'menu item', 'menuitem', 'field', 'box', 'checkbox', 'check box',
  'tab', 'link', 'control', 'entry', 'input', 'option', 'toggle',
];

export function controlQuery(raw: string): string {
  let q = String(raw ?? '').trim().toLowerCase();
  q = q.replace(/^(?:the|a|an)\s+/, '');
  for (const role of ROLE_WORDS) {
    const suffix = ` ${role}`;
    if (q.endsWith(suffix) && q.length > suffix.length) {
      q = q.slice(0, -suffix.length).trim();
      break;
    }
  }
  return q;
}

/** "&Save As..." → "save as" */
function plainName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, '')
    .replace(/\.\.\.$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findControlByName(root: UiaNode, query: string): UiaNode | null {
  const q = controlQuery(query);
  if (!q) return null;
  const nodes = flatten(root);

  // A disabled control is a real answer only when nothing enabled matches, so
  // each pass is run over the enabled nodes first.
  const tiers: ((n: UiaNode) => boolean)[] = [
    (n) => n.name.toLowerCase() === q,
    (n) => n.automationId.toLowerCase() === q,
    (n) => plainName(n.name) === q,
    (n) => plainName(n.name).includes(q),
  ];

  for (const matches of tiers) {
    for (const onlyEnabled of [true, false]) {
      const hit = nodes.find((n) => matches(n) && (!onlyEnabled || n.enabled));
      if (hit) return hit;
    }
  }
  return null;
}

export function createUiaSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  /**
   * The `{ id }` a window-targeting skill needs, or the response to hand
   * straight back. `skillId`/`args` are only for rebuilding a disambiguation
   * row's action — re-running the *same* skill call with `window` swapped for
   * the exact candidate's `id`, which `resolveWindow` now matches directly.
   */
  async function targetWindowId(
    query: string,
    ctx: { showResults?: (items: ResultRow[], meta?: { title?: string; subtitle?: string }) => void },
    skillId: string,
    args: SkillArgs,
  ): Promise<{ id: string; title: string } | { early: { ok: boolean; message?: string; error?: string; spoken?: true } }> {
    const match = resolveWindow(await liveWindows(platform), query);
    if (match.kind === 'none') {
      return { early: { ok: false, error: `I can't find a window called "${query}".` } };
    }
    if (match.kind === 'many') {
      ctx.showResults?.(
        match.candidates.slice(0, 12).map((w) => ({
          title: w.title,
          subtitle: w.processName,
          icon: '🪟',
          payload: w,
          actions: [{ label: 'Select', skill: skillId, args: { ...args, window: w.id } }],
        })),
        { title: `${match.candidates.length} windows match "${query}"`, subtitle: 'Click one, or say which.' },
      );
      return { early: { ok: true, spoken: true, message: '' } };
    }
    return { id: match.entry.id, title: match.entry.title };
  }

  /**
   * The control an action should act on: `path` when given, otherwise the
   * `control` name, resolved against a freshly read tree.
   *
   * Read fresh every time rather than cached, which is the same discipline
   * `models/uia.ts` describes for paths — a tree read a moment ago may not
   * describe the window as it is now, and acting on a stale index is how a
   * "click Save" ends up pressing whatever moved into that slot.
   */
  async function targetPath(
    windowId: string,
    args: SkillArgs,
  ): Promise<{ path: number[] } | { error: string }> {
    if (String(args.path ?? '').trim()) return { path: parsePath(args.path) };

    const control = String(args.control ?? '').trim();
    if (!control) {
      return { error: 'Tell me which control — by name, or by a path from the control tree.' };
    }
    const tree = await platform.uiaTree?.(windowId);
    if (!tree) return { error: "I couldn't read that window's controls." };

    const found = findControlByName(tree, control);
    if (!found) return { error: `I can't find a control called “${control}” in that window.` };
    if (!found.enabled) return { error: `“${found.name || control}” is there, but greyed out.` };
    return { path: found.path };
  }

  /** The `control` parameter every acting skill gained, described once. */
  const CONTROL_PARAM = {
    type: 'string',
    description: 'the control by name, e.g. "save" or "the save button"',
  } as const;

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
      const target = await targetWindowId(String(args.window ?? ''), ctx, 'uia.tree', args);
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
      'Click, toggle or select a control by name — or by a path from uia.tree — whichever action pattern it actually supports.',
    needs: ['ui-automation', 'window-control'],
    // A mechanism, not a consequence — see the file doc comment.
    risk: 'safe',
    examples: ['activate the save button in the notepad window'],
    params: {
      window: { type: 'string', required: true, description: 'the window, by its title or app name' },
      control: CONTROL_PARAM,
      path: { type: 'string', description: 'the control\'s path from uia.tree, e.g. "2,0,1" (empty for the root)' },
    },
    async run(args, ctx) {
      const target = await targetWindowId(String(args.window ?? ''), ctx, 'uia.invoke', args);
      if ('early' in target) return target.early;

      const at = await targetPath(target.id, args);
      if ('error' in at) return { ok: false, error: at.error };

      const ok = await platform.uiaInvoke?.(target.id, at.path);
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
    risk: 'safe',
    examples,
    params: {
      window: { type: 'string', required: true, description: 'the window, by its title or app name' },
      control: CONTROL_PARAM,
      path: { type: 'string', description: 'the control\'s path from uia.tree' },
    },
    async run(args, ctx) {
      const target = await targetWindowId(String(args.window ?? ''), ctx, id, args);
      if ('early' in target) return target.early;
      const at = await targetPath(target.id, args);
      if ('error' in at) return { ok: false, error: at.error };
      const ok = await platform.uiaSetExpanded?.(target.id, at.path, expand);
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
      'Set a text field directly, by name or by a path from uia.tree — only works when the control supports it.',
    needs: ['ui-automation', 'window-control'],
    risk: 'safe',
    examples: ['set the search field in the notepad window to hello'],
    params: {
      window: { type: 'string', required: true, description: 'the window, by its title or app name' },
      control: CONTROL_PARAM,
      path: { type: 'string', description: 'the control\'s path from uia.tree' },
      value: { type: 'string', required: true, description: 'the text to set' },
    },
    async run(args, ctx) {
      const target = await targetWindowId(String(args.window ?? ''), ctx, 'uia.setValue', args);
      if ('early' in target) return target.early;
      const at = await targetPath(target.id, args);
      if ('error' in at) return { ok: false, error: at.error };
      const ok = await platform.uiaSetValue?.(target.id, at.path, String(args.value ?? ''));
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
      'Type text into a field, by name or by a path from uia.tree. Sets the value directly when the control supports it; otherwise focuses it and types, one keystroke at a time.',
    needs: ['ui-automation', 'window-control', 'input'],
    risk: 'safe',
    examples: ['type "hello" into the search field in the notepad window'],
    params: {
      window: { type: 'string', required: true, description: 'the window, by its title or app name' },
      control: CONTROL_PARAM,
      path: { type: 'string', description: 'the control\'s path from uia.tree' },
      text: { type: 'string', required: true, description: 'the text to type' },
    },
    async run(args, ctx) {
      const target = await targetWindowId(String(args.window ?? ''), ctx, 'uia.typeInto', args);
      if ('early' in target) return target.early;

      const at = await targetPath(target.id, args);
      if ('error' in at) return { ok: false, error: at.error };
      const path = at.path;
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
