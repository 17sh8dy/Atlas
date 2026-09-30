/**
 * What a click, a keypress or a drag would land on — worked out before it
 * happens, for the hands that do not name a control (`input.*`, `kbm.*`).
 *
 * ── Why a coordinate is not a target ────────────────────────────────────────
 * "Click at 400, 300" says where, not what. Windows move, layouts change, and a
 * payment button can sit where an ordinary one was a moment ago. So before a
 * coordinate click is treated as harmless Atlas looks at what is *there*: which
 * window owns the point, what the accessibility tree says is at that spot, and
 * runs it through the same judgement a named button gets (`assessControl`).
 *
 *  - a verified, harmless control → goes ahead, no card;
 *  - a control that would pay, send, delete, install… → asks, naming it;
 *  - nothing reliable there (no window, a tree that can't be read, only a big
 *    empty pane or a web page's content) → asks, and says it cannot tell.
 *
 * The card names the actual action and target — "Click “Pay now” (button) in
 * Checkout at 400, 300" — so a yes is about that, not about a bare coordinate.
 * The same holds for Enter and Space, which press whatever has focus: they are
 * judged by the focused control, and asked about when it can't be identified.
 *
 * Read-only. It lists windows and reads a tree; it never acts. Two limits, said
 * plainly: the tree is read here and the click happens a moment later, so a
 * window that changes in between is not caught; and a page that exposes no
 * accessibility tree (a game, a canvas, a browser with accessibility off) gets
 * asked about every time, because there is nothing to verify.
 */

import type { InputTarget, Platform, SkillAssessment, UiaNode, WindowEntry } from '@atlas/core';
import { assessControl, classifyText } from './ui-consequence';

/** A container that says nothing about what a click inside it does. */
const VAGUE_ROLES =
  /^(pane|window|group|custom|document|list|table|tab|tool bar|toolbar|status bar|title bar)$/;

/** Roles that hold text a person types into; Enter there is not "press a button". */
const TEXT_ENTRY = /^(edit|text|document|combo box|combobox)$/;

function contains(node: UiaNode, x: number, y: number): boolean {
  return (
    node.width > 0 &&
    node.height > 0 &&
    x >= node.x &&
    y >= node.y &&
    x < node.x + node.width &&
    y < node.y + node.height
  );
}

/** The most specific node under a point — the deepest one whose box holds it. */
export function deepestAt(root: UiaNode, x: number, y: number): UiaNode | null {
  if (!contains(root, x, y)) {
    // A window's own root can report no box; its children still may.
    for (const child of root.children) {
      const hit = deepestAt(child, x, y);
      if (hit) return hit;
    }
    return null;
  }
  for (const child of root.children) {
    const hit = deepestAt(child, x, y);
    if (hit) return hit;
  }
  return root;
}

/** The window under a point, topmost first (the order the platform lists them in). */
export function windowAt(
  windows: readonly WindowEntry[],
  x: number,
  y: number,
): WindowEntry | null {
  return (
    windows.find(
      (w) =>
        !w.minimized &&
        w.title.trim() !== '' &&
        x >= w.x &&
        y >= w.y &&
        x < w.x + w.width &&
        y < w.y + w.height,
    ) ?? null
  );
}

const describe = (node: UiaNode) =>
  `${node.name ? `“${node.name}”` : 'an unnamed control'} (${node.role || 'control'})`;

function ask(question: string, detail: string): SkillAssessment {
  return { kind: 'ask', question, detail };
}

/**
 * Ask the native side whether input to this target is allowed at all, before
 * anything is put to the person. A Windows permission screen, a window running
 * above Atlas, or something it cannot identify comes back as a *refusal* — not
 * a question a yes could unlock.
 *
 * A platform with no probe (the browser build, a test double) returns `null`
 * and the native input commands remain the guarantee; a probe that exists but
 * cannot answer is treated as a refusal, because not being able to check is not
 * the same as it being safe.
 */
export async function probeTarget(
  platform: Platform,
  target: InputTarget,
): Promise<SkillAssessment | null> {
  if (!platform.inputProbe) return null;
  try {
    const probe = await platform.inputProbe(target);
    if (probe.allowed) return null;
    return {
      kind: 'refuse',
      message: probe.message ?? 'Atlas can’t send input there, so it didn’t.',
    };
  } catch {
    return {
      kind: 'refuse',
      message: 'I couldn’t check where that input would go, so I didn’t send it.',
    };
  }
}

export type ClickKind = 'Click' | 'Double-click' | 'Right-click' | 'Middle-click' | 'Drag from';

/** What a click at (x, y) would land on. */
export async function assessPoint(
  platform: Platform,
  x: number,
  y: number,
  verb: ClickKind = 'Click',
): Promise<SkillAssessment> {
  const at = `at ${Math.round(x)}, ${Math.round(y)}`;
  const refused = await probeTarget(platform, { x: Math.round(x), y: Math.round(y) });
  if (refused) return refused;
  const windows = (await platform.listWindows?.().catch(() => [])) ?? [];
  const win = windowAt(windows, x, y);
  if (!win) {
    return ask(
      `${verb} ${at}?`,
      'There is no window I can identify there, so I cannot tell what this would do.',
    );
  }

  const tree = await platform.uiaTree?.(win.id).catch(() => null);
  if (!tree) {
    return ask(
      `${verb} ${at} in ${win.title}?`,
      'I cannot read that window’s controls, so I cannot tell what this would do.',
    );
  }

  const node = deepestAt(tree, x, y);
  if (!node || node === tree || (VAGUE_ROLES.test(node.role) && !node.name.trim())) {
    return ask(
      `${verb} ${at} in ${win.title}?`,
      'Nothing identifiable is at that spot — only an empty area or page content — so I cannot tell what this would do.',
    );
  }

  const verdict = assessControl({ root: tree, node, windowTitle: win.title });
  if (verdict.kind === 'routine') return { kind: 'routine' };
  return ask(
    `${verb} ${describe(node)} in ${win.title}, ${at}?`,
    `I checked what is there before clicking: ${verdict.reason}.`,
  );
}

/** Keys that press whatever has focus. */
export function activatesFocused(key: string): boolean {
  const parts = key
    .toLowerCase()
    .split('+')
    .map((p) => p.trim());
  return parts.some((p) => ['enter', 'return', 'space', 'spacebar', 'numpadenter'].includes(p));
}

/** What Enter or Space would press, judged by the control that has focus. */
export async function assessFocused(
  platform: Platform,
  keyLabel: string,
): Promise<SkillAssessment> {
  const refused = await probeTarget(platform, {});
  if (refused) return refused;
  const focused = await platform.uiaFocusedElement?.().catch(() => null);
  const active = await platform.activeWindow?.().catch(() => null);
  if (!focused) {
    return ask(
      `Press ${keyLabel}?`,
      'I cannot tell which control has focus, so I cannot tell what this would do.',
    );
  }

  const title = active?.title ?? '';
  const name = focused.name.trim();

  // Enter in a text field submits or breaks a line. Judge it by what the field
  // and its window say, since there is no button to read.
  if (TEXT_ENTRY.test(focused.role)) {
    for (const text of [name, title]) {
      const hit = classifyText(text);
      if (hit && hit.kind !== 'send' && hit.kind !== 'install') {
        return ask(
          `Press ${keyLabel} in ${describe(focused)}${title ? `, in ${title}` : ''}?`,
          `${text.trim().slice(0, 80)} — this could ${hit.effect}.`,
        );
      }
    }
    return { kind: 'routine' };
  }

  // A button (or anything else that activates): find it in its window's tree so
  // the words around it count, falling back to the element alone.
  const tree = active ? await platform.uiaTree?.(active.id).catch(() => null) : null;
  const inTree = tree ? findSame(tree, focused) : null;
  const verdict = assessControl({
    root: tree ?? focused,
    node: inTree ?? focused,
    windowTitle: title,
  });
  if (verdict.kind === 'routine') return { kind: 'routine' };
  return ask(
    `Press ${keyLabel} on ${describe(focused)}${title ? ` in ${title}` : ''}?`,
    `I checked what has focus before pressing: ${verdict.reason}.`,
  );
}

function findSame(root: UiaNode, target: UiaNode): UiaNode | null {
  if (
    root.name === target.name &&
    root.role === target.role &&
    root.x === target.x &&
    root.y === target.y
  ) {
    return root;
  }
  for (const child of root.children) {
    const hit = findSame(child, target);
    if (hit) return hit;
  }
  return null;
}
