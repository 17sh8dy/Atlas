/**
 * "The Notepad window" → a live one, or a reason there wasn't one.
 *
 * `app.open` resolves a spoken app name against the installed-apps list;
 * `service-skills.ts` resolves a spoken service name against the services
 * list. This is the same shape a third time, for window titles — pulled out
 * once so `window-skills.ts`, and anything later that needs "which window did
 * they mean" (UI Automation, input targeting), share one resolver instead of
 * three slightly different ones drifting apart.
 *
 * Titles are free text, not an enum of known names, so the passes stay in the
 * "obviously this one" register — exact, then prefix, then contains — rather
 * than reaching for typo tolerance the way `fuzzy.ts` does for app names.
 * "ntoepad" for a window title is rare enough, and the cost of guessing wrong
 * (focusing or closing the wrong window) is high enough, that asking rather
 * than guessing is the right trade here.
 */

import type { Platform, WindowEntry } from '@atlas/core';

export type WindowMatch =
  | { kind: 'one'; entry: WindowEntry }
  | { kind: 'none' }
  | { kind: 'many'; candidates: WindowEntry[] };

/** What "the notepad window" or "my browser" is actually asking about. */
function tidyQuery(raw: string): string {
  return String(raw)
    .toLowerCase()
    .replace(/^\s*(?:the|my|a|an)\s+/, '')
    .replace(/\s+window$/, '')
    .replace(/[?.!,]+$/, '')
    .trim();
}

/**
 * Which window did they mean? Three passes, narrowest first, stopping at the
 * first that lands on exactly one — the same shape `resolveService` uses, for
 * the same reason: a looser pass only runs once a stricter one has failed to
 * settle it alone.
 */
export function resolveWindow(windows: readonly WindowEntry[], query: string): WindowMatch {
  // A disambiguation card's own action buttons re-invoke the skill with the
  // exact `id` of the row that was clicked — never something a person would
  // type themselves, so checking it first can't shadow a real title query.
  const byId = windows.find((w) => w.id === query.trim());
  if (byId) return { kind: 'one', entry: byId };

  const q = tidyQuery(query);
  if (!q) return { kind: 'none' };

  const exact = windows.filter(
    (w) => w.title.toLowerCase() === q || w.processName.toLowerCase() === q,
  );
  if (exact.length === 1) return { kind: 'one', entry: exact[0]! };

  const startsWith = windows.filter(
    (w) => w.title.toLowerCase().startsWith(q) || w.processName.toLowerCase().startsWith(q),
  );
  if (startsWith.length === 1) return { kind: 'one', entry: startsWith[0]! };

  const contains = windows.filter(
    (w) => w.title.toLowerCase().includes(q) || w.processName.toLowerCase().includes(q),
  );
  if (contains.length === 1) return { kind: 'one', entry: contains[0]! };

  const candidates = exact.length ? exact : startsWith.length ? startsWith : contains;
  if (!candidates.length) return { kind: 'none' };
  return { kind: 'many', candidates };
}

/** `listWindows` behind the one capability check every caller would repeat. */
export async function liveWindows(platform: Platform): Promise<WindowEntry[]> {
  return (await platform.listWindows?.()) ?? [];
}
