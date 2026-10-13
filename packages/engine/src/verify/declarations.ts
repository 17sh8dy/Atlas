/**
 * Which skills declare a read-back, and what it reads — as one table.
 *
 * Kept in one place on purpose: a reviewer can see every claim Atlas will make about having
 * "confirmed" something, and each is a handful of data fields rather than code that runs.
 * `SkillRegistry.register` attaches an entry to the skill with the matching id unless the
 * skill brought its own `verify`.
 *
 * What belongs here: an effect that is cheap to read and unambiguous once read. What does
 * not: anything whose success depends on a user choice or a slow third party the read cannot
 * distinguish from failure.
 */

import type { ProbeSpec, Skill, SkillArgs } from '@atlas/core';

function text(args: SkillArgs, key: string): string {
  const v = args[key];
  return v === undefined || v === null ? '' : String(v);
}

/** The last path segment, whichever slash the path uses. */
export function leaf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : '';
}

/** Everything before the last segment, keeping the original slash style. */
export function parent(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut > 0 ? path.slice(0, cut) : '';
}

export function join(dir: string, name: string): string {
  const slash = dir.includes('\\') || /^[A-Za-z]:/.test(dir) ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${slash}${name}`;
}

type Declaration = NonNullable<Skill['verify']>;

const inFolder = (a: SkillArgs): ProbeSpec[] => {
  const dest = text(a, 'destDir');
  const name = leaf(text(a, 'path'));
  return dest && name ? [{ kind: 'path-exists', path: join(dest, name) }] : [];
};

export const VERIFY_DECLARATIONS: Readonly<Record<string, Declaration>> = {
  // Immediate facts about the disk: said out loud if they read the opposite.
  'files.create': (a) => (text(a, 'path') ? [{ kind: 'path-is-file', path: text(a, 'path'), announce: true }] : []),
  'files.createFolder': (a) =>
    text(a, 'path') ? [{ kind: 'path-is-folder', path: text(a, 'path'), announce: true }] : [],
  'files.delete': (a) => (text(a, 'path') ? [{ kind: 'path-absent', path: text(a, 'path'), announce: true }] : []),

  // A name can legitimately change on a collision, so a miss is recorded, not announced.
  'files.rename': (a) => {
    const dir = parent(text(a, 'path'));
    const name = text(a, 'newName');
    return dir && name ? [{ kind: 'path-exists', path: join(dir, name) }] : [];
  },
  'files.move': inFolder,
  'files.copy': inFolder,

  // Slow, and sometimes handed off to another process: recorded, never announced.
  'app.open': (a) => (text(a, 'name') ? [{ kind: 'process-running', name: text(a, 'name') }] : []),
};
