/**
 * "OBS" → `obs64.exe`. Turning the name a person uses for an app into the
 * process that is actually running it.
 *
 * Needed by Watch ("tell me when OBS closes") and by setups ("is Fortnite
 * running yet?"), both of which have to *read* whether an app is up rather
 * than trust that a launch worked. The spoken name and the image name
 * routinely disagree — "Fortnite" is `FortniteClient-Win64-Shipping.exe`,
 * "Edge" is `msedge.exe`, "Word" is `WINWORD.EXE` — so this tries, in order:
 *
 *   1. an alias table for the well-known mismatches,
 *   2. the image name itself (exact, then prefix, then containing),
 *   3. a visible window whose title carries the name, and its process.
 *
 * Every step is a *reading* of what is running now. Nothing here launches,
 * closes or guesses at something that is not there.
 */

import type { ProcessEntry, WindowEntry } from '@atlas/core';

/** Image names (lowercase, no `.exe`) for names people say that don't match them. */
const ALIASES: Record<string, readonly string[]> = {
  obs: ['obs64', 'obs32', 'obs'],
  'obs studio': ['obs64', 'obs32', 'obs'],
  fortnite: ['fortniteclient-win64-shipping', 'fortnitelauncher'],
  edge: ['msedge'],
  'microsoft edge': ['msedge'],
  chrome: ['chrome'],
  'google chrome': ['chrome'],
  'epic games': ['epicgameslauncher'],
  'epic games launcher': ['epicgameslauncher'],
  epic: ['epicgameslauncher'],
  'vs code': ['code'],
  vscode: ['code'],
  'visual studio code': ['code'],
  'visual studio': ['devenv'],
  word: ['winword'],
  'microsoft word': ['winword'],
  excel: ['excel'],
  powerpoint: ['powerpnt'],
  teams: ['ms-teams', 'teams'],
  'microsoft teams': ['ms-teams', 'teams'],
  premiere: ['adobe premiere pro'],
  'premiere pro': ['adobe premiere pro'],
  photoshop: ['photoshop'],
  'file explorer': ['explorer'],
  terminal: ['windowsterminal'],
  'windows terminal': ['windowsterminal'],
  'nova cut': ['nova cut', 'novacut'],
  xbox: ['xboxpcapp'],
  roblox: ['robloxplayerbeta', 'robloxstudiobeta'],
  minecraft: ['minecraft.windows', 'javaw', 'minecraftlauncher'],
  'battle.net': ['battle.net'],
  valorant: ['valorant-win64-shipping', 'riotclientservices'],
  'league of legends': ['leagueclient', 'league of legends'],
};

/** Image names a watch or a setup must never treat as "the app" — closing them ends the session. */
export const PROTECTED_PROCESSES: readonly string[] = [
  'explorer',
  'dwm',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'lsass',
  'smss',
  'svchost',
  'system',
  'atlas-desktop',
];

/** `OBS64.EXE` → `obs64`. */
export function imageKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '');
}

/** "OBS Studio " → "obs studio". */
function spokenKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/^(?:the|my)\s+/, '')
    .replace(/\s+(?:app|application|program|window)$/, '')
    .replace(/\s+/g, ' ');
}

export type ProcessMatch =
  | { kind: 'one'; name: string; pids: number[] }
  | { kind: 'many'; names: string[] }
  | { kind: 'none' };

/**
 * Which running process is `query`? Groups by image name, so a browser with
 * twenty `chrome.exe` processes is one answer, not twenty.
 */
export function matchRunningProcess(
  query: string,
  processes: readonly ProcessEntry[],
  windows: readonly WindowEntry[] = [],
): ProcessMatch {
  const key = spokenKey(query);
  if (!key) return { kind: 'none' };

  const byImage = new Map<string, { name: string; pids: number[] }>();
  for (const p of processes) {
    const k = imageKey(p.name);
    if (PROTECTED_PROCESSES.includes(k)) continue;
    const entry = byImage.get(k) ?? { name: p.name, pids: [] };
    entry.pids.push(p.pid);
    byImage.set(k, entry);
  }
  const pick = (keys: string[]): ProcessMatch => {
    const unique = [...new Set(keys)];
    if (unique.length === 1) {
      const hit = byImage.get(unique[0]!)!;
      return { kind: 'one', name: hit.name, pids: hit.pids };
    }
    if (unique.length > 1) return { kind: 'many', names: unique.map((k) => byImage.get(k)!.name) };
    return { kind: 'none' };
  };

  // 1. Aliases, in the table's order of preference.
  for (const alias of ALIASES[key] ?? []) {
    if (byImage.has(alias)) return pick([alias]);
  }

  const compact = key.replace(/[\s._-]+/g, '');
  const images = [...byImage.keys()];

  // 2. The image name.
  const exact = images.filter((k) => k === key || k.replace(/[\s._-]+/g, '') === compact);
  if (exact.length) return pick(exact);
  if (compact.length >= 3) {
    const prefix = images.filter((k) => k.replace(/[\s._-]+/g, '').startsWith(compact));
    if (prefix.length) return pick(prefix);
  }
  if (compact.length >= 4) {
    const contains = images.filter((k) => k.replace(/[\s._-]+/g, '').includes(compact));
    if (contains.length) return pick(contains);
  }

  // 3. A window titled with the name — "OBS 30.2 - Profile: …" is obs64.exe.
  if (key.length >= 3) {
    const word = new RegExp(
      `(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`,
      'i',
    );
    const owners = windows
      .filter((w) => word.test(w.title))
      .map((w) => imageKey(w.processName))
      .filter((k) => byImage.has(k));
    if (owners.length) return pick(owners);
  }
  return { kind: 'none' };
}

/** Is anything matching `query` running? A convenience over `matchRunningProcess`. */
export function isRunning(
  query: string,
  processes: readonly ProcessEntry[],
  windows: readonly WindowEntry[] = [],
): boolean {
  return matchRunningProcess(query, processes, windows).kind !== 'none';
}

/**
 * Build tools a "when the build finishes" can mean — the orchestrators, not
 * every compiler they spawn, so one build is one answer. `node` is absent on
 * purpose: it runs half the desktop, and "the build" being Discord's updater
 * is the wrong kind of surprise.
 */
export const BUILD_PROCESSES: readonly string[] = [
  'cargo',
  'msbuild',
  'dotnet',
  'cmake',
  'ninja',
  'make',
  'mingw32-make',
  'gradle',
  'mvn',
  'devenv',
  'unrealbuildtool',
  'bazel',
];
