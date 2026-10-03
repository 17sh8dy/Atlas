/**
 * "That path is outside the folders Atlas can touch" — and what to do about it.
 *
 * Adding a folder to Allowed Folders is the one thing that widens where every
 * file command may act, so it is only ever done on a person's say-so, on a card
 * that names the exact folder. This module decides *which* folder to offer and
 * whether it is reasonable to offer at all; the card and the add live in
 * `useAtlas`.
 *
 * What it will not offer, whatever the request: a whole drive, or a place that
 * holds the system or other programs' private data. A person can still add
 * those by hand in Settings — that is their decision to make deliberately, not
 * something to tee up as a one-click answer to a failed "open this".
 */

import type { PathInfo, SkillArgs } from '@atlas/core';
import { embeddedPaths } from '@atlas/engine';

function normalize(path: string): string {
  return path.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** Is `path` inside (or equal to) any of the allowed folders? */
export function isInsideAnyAllowedFolder(path: string, allowedFolders: readonly string[]): boolean {
  const target = normalize(path);
  return allowedFolders.some((root) => {
    const normalizedRoot = normalize(root);
    return (
      Boolean(normalizedRoot) &&
      (target === normalizedRoot || target.startsWith(`${normalizedRoot}\\`))
    );
  });
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** A whole drive, the system, installed programs, or per-user application data. */
export function isSensitiveFolder(folder: string): boolean {
  const p = normalize(folder);
  if (/^[a-z]:$/.test(p) || p === '') return true;
  if (
    /^[a-z]:\\(windows|program files|program files \(x86\)|programdata|\$recycle\.bin|system volume information)(\\|$)/.test(
      p,
    )
  ) {
    return true;
  }
  return /\\appdata(\\|$)/.test(p);
}

function parentOf(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return cut > 2 ? trimmed.slice(0, cut) : trimmed.slice(0, cut + 1);
}

/** How far up from a path that does not exist yet to look for a folder that does. */
const MAX_LEVELS_UP = 3;

/**
 * What exists at, or just above, `path`. Something being created ("build it in
 * D:\Dev\Clicker", "save it to E:\Games\notes.txt") names a place that is not
 * there yet, and the folder that has to be allowed is the one it will be made
 * in — the nearest ancestor that exists, a few levels up at most so a typo'd
 * drive never turns into an offer to add the whole drive.
 */
async function nearestExisting(
  path: string,
  pathInfo: (path: string) => Promise<PathInfo>,
): Promise<{ folder: string } | null> {
  let current = path;
  for (let level = 0; level <= MAX_LEVELS_UP; level++) {
    const info = await pathInfo(current).catch(() => null);
    if (info) return { folder: info.isDirectory ? current : parentOf(current) };
    const up = parentOf(current);
    if (!up || up === current) return null;
    current = up;
  }
  return null;
}

/**
 * The paths a step names: a whole argument that is a path, or — for an argument that is text with
 * paths written inside it, like a PowerShell script — each path found in the text.
 */
function pathsIn(value: string): string[] {
  const whole = value
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
  if (ABSOLUTE.test(whole) && !/[\r\n]/.test(whole)) return [whole];
  return /[A-Za-z]:[\\/]|\\\\/.test(value) ? embeddedPaths(value) : [];
}

/**
 * The folder worth offering to add, given the arguments of the step that was
 * refused: the first absolute path that is not already allowed, whose folder
 * really exists (or is the nearest one that does, for something about to be
 * created), and that is not somewhere it would be unwise to offer. A file offers
 * its folder. `undefined` means "nothing to offer" and the failure stands.
 */
export async function folderToOffer(
  args: SkillArgs,
  allowedFolders: readonly string[],
  pathInfo: (path: string) => Promise<PathInfo>,
): Promise<string | undefined> {
  for (const value of Object.values(args)) {
    if (typeof value !== 'string') continue;
    for (const path of pathsIn(value)) {
      if (isInsideAnyAllowedFolder(path, allowedFolders)) continue;
      const found = await nearestExisting(path, pathInfo);
      if (!found) continue;
      const { folder } = found;
      if (isSensitiveFolder(folder)) continue;
      if (isInsideAnyAllowedFolder(folder, allowedFolders)) continue;
      return folder;
    }
  }
  return undefined;
}
