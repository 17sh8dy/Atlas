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

/**
 * The folder worth offering to add, given the arguments of the step that was
 * refused: the first absolute path that is not already allowed, that really
 * exists, and that is not somewhere it would be unwise to offer. A file offers
 * its folder. `undefined` means "nothing to offer" and the failure stands.
 */
export async function folderToOffer(
  args: SkillArgs,
  allowedFolders: readonly string[],
  pathInfo: (path: string) => Promise<PathInfo>,
): Promise<string | undefined> {
  for (const value of Object.values(args)) {
    if (typeof value !== 'string') continue;
    const path = value
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim();
    if (!ABSOLUTE.test(path)) continue;
    if (isInsideAnyAllowedFolder(path, allowedFolders)) continue;
    const info = await pathInfo(path).catch(() => null);
    if (!info) continue;
    const folder = info.isDirectory ? path : parentOf(path);
    if (isSensitiveFolder(folder)) continue;
    if (isInsideAnyAllowedFolder(folder, allowedFolders)) continue;
    return folder;
  }
  return undefined;
}
