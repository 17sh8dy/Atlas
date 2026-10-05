/**
 * Reading and rewriting a project's files, safely — the rails every bulk project tool shares.
 *
 * `project.recolor`, `code.replaceAll`, `project.stats` and `project.todos` all start the same way
 * (look at every text file in a folder, skipping the ones nobody means) and the two that WRITE end
 * the same way (copy the originals aside first, then overwrite, and keep a way back). Keeping that
 * in one place is what makes "nothing is lost" true of all of them rather than of whichever one was
 * written most carefully.
 *
 *   · LOOKING is read-only and bounded: at most `MAX_FILES` files, none over the 256 KB read cap,
 *     never `node_modules`, `.git`, build output, lockfiles or Atlas's own backups.
 *   · WRITING copies the original to `.atlas-backup\<label>-<time>\<same path>` FIRST. If that copy
 *     fails, that file is not touched. Nothing is ever deleted — a restored backup is marked, not
 *     removed, because Atlas does not delete folders unasked.
 *   · Every path goes through `readTextFile` / `writeTextFile` / `createFile`, so a folder Atlas is
 *     not allowed to use is refused by the same layer that raises the "Add It?" card.
 */

import type { Platform, SkillContext } from '@atlas/core';

export const BACKUP_DIR = '.atlas-backup';
/** Marks a backup that has been put back, so "undo" moves on to the one before it. */
export const RESTORED_MARKER = 'RESTORED.txt';
export const MAX_FILES = 200;

/** Folders and files nobody means: dependencies, build output, version control, lockfiles, our own backups. */
export const NEVER =
  /(?:^|[\\/])(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|composer\.lock|node_modules|\.git|dist|build|out|release|target|\.venv|venv|__pycache__|\.next|\.cache|\.atlas-backup)(?:[\\/]|$)/i;

/** Extensions that are text a person wrote. Anything else (images, binaries, archives) is never read. */
const TEXT_EXT = new Set(
  (
    'js mjs cjs jsx ts tsx css scss sass less html htm vue svelte json jsonc md markdown txt py rs go java kt kts c h cpp cc hpp cs ' +
    'lua gd gdscript rb php swift sh bash ps1 bat cmd sql yml yaml toml xml ini cfg conf env csv tsv svg'
  ).split(' '),
);

export const extOf = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
export const isTextFile = (path: string) => TEXT_EXT.has(extOf(path));

export const trimPath = (path: string) => path.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function stamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** A path under `root`, as the relative path with forward slashes — or null if it is not under it. */
export function relativeTo(root: string, path: string): string | null {
  const r = root.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '') + '\\';
  const p = path.replace(/\//g, '\\');
  if (!p.toLowerCase().startsWith(r)) return null;
  return p.slice(r.length).replace(/\\/g, '/');
}

export interface ProjectFile {
  /** Full path on disk. */
  path: string;
  /** Path relative to the project folder, with forward slashes. */
  rel: string;
  text: string;
}

export interface Gathered {
  files: ProjectFile[];
  /** Files that were too big to read, unreadable, or past the cap — never half-handled. */
  skipped: number;
}

/**
 * Every file under `root` that `accept` allows, with its text. Read-only, so safe from `preview`.
 * `accept` is given the full path; it is only ever asked about files the project could contain.
 */
export async function readProjectFiles(
  platform: Platform,
  root: string,
  accept: (path: string) => boolean = isTextFile,
): Promise<Gathered | { error: string }> {
  if (!platform.dirTree || !platform.readTextFile) return { error: "I can't read project files on this device." };
  let tree;
  try {
    tree = await platform.dirTree(root, 6, 2000);
  } catch (e) {
    return { error: e instanceof Error ? e.message : `I couldn't look inside ${root}.` };
  }
  const wanted = tree.filter((t) => !t.isDirectory && accept(t.path) && !NEVER.test(t.path));
  const files: ProjectFile[] = [];
  let skipped = 0;
  for (const entry of wanted.slice(0, MAX_FILES)) {
    const rel = relativeTo(root, entry.path);
    if (!rel) continue;
    try {
      files.push({ path: entry.path, rel, text: await platform.readTextFile(entry.path) });
    } catch {
      skipped += 1; // over the 256 KB read cap, or unreadable
    }
  }
  skipped += Math.max(0, wanted.length - MAX_FILES);
  return { files, skipped };
}

/** One file's change: what it was, what it becomes. */
export interface Change {
  /** Relative path, forward slashes. */
  rel: string;
  /** Full path to overwrite. */
  path: string;
  before: string;
  after: string;
}

async function ensureFolders(platform: Platform, base: string, relFile: string) {
  const parts = relFile.split('/');
  for (let i = 1; i < parts.length; i++) {
    await platform.createFolder?.(`${base}\\${parts.slice(0, i).join('\\')}`).catch(() => undefined);
  }
}

export type WriteOutcome = { ok: true; backup: string; done: string[] } | { ok: false; error: string };

/**
 * Back every original up, then overwrite. A file whose backup could not be made is not touched, and
 * a failure part-way says exactly which files were already changed so the undo knows what it has.
 */
export async function backupThenWrite(
  platform: Platform,
  root: string,
  label: string,
  changes: readonly Change[],
  ctx?: SkillContext,
  activityLabel = 'Writing',
): Promise<WriteOutcome> {
  if (!platform.writeTextFile || !platform.createFile || !platform.createFolder) {
    return { ok: false, error: "I can't write files on this device." };
  }
  const backup = `${root}\\${BACKUP_DIR}\\${label}-${stamp()}`;
  const step = ctx?.activity?.step(activityLabel, `0 of ${changes.length}`);
  const done: string[] = [];
  try {
    await platform.createFolder(`${root}\\${BACKUP_DIR}`).catch(() => undefined);
    await platform.createFolder(backup);
    for (const change of changes) {
      await ensureFolders(platform, backup, change.rel);
      await platform.createFile(`${backup}\\${change.rel.replace(/\//g, '\\')}`, change.before);
      await platform.writeTextFile(change.path, change.after);
      done.push(change.rel);
      step?.update(`${done.length} of ${changes.length}`);
    }
  } catch (e) {
    step?.failed();
    const why = e instanceof Error ? e.message : String(e);
    const left = done.length ? ` I had already changed ${done.join(', ')}; the undo puts those back.` : '';
    return { ok: false, error: `${why}${left}` };
  }
  step?.done();
  return { ok: true, backup, done };
}

export type RestoreOutcome =
  | { ok: true; restored: string[] }
  | { ok: false; error: string }
  | { ok: true; restored: []; none: true };

/** Put back the newest backup set with this label that has not already been restored. */
export async function restoreLatestBackup(platform: Platform, root: string, label: string): Promise<RestoreOutcome> {
  if (!platform.listDir || !platform.dirTree || !platform.readTextFile || !platform.writeTextFile || !platform.createFile) {
    return { ok: false, error: "I can't edit files on this device." };
  }
  const folder = `${root}\\${BACKUP_DIR}`;
  const entries = await platform.listDir(folder, 500).catch(() => []);
  const sets = entries.filter((e) => e.isDirectory && e.name.startsWith(`${label}-`)).map((e) => e.name).sort();

  let chosen: string | null = null;
  for (const name of [...sets].reverse()) {
    const inside = await platform.listDir(`${folder}\\${name}`, 500).catch(() => []);
    if (!inside.some((e) => e.name === RESTORED_MARKER)) {
      chosen = name;
      break;
    }
  }
  if (!chosen) return { ok: true, restored: [], none: true };

  const base = `${folder}\\${chosen}`;
  const tree = await platform.dirTree(base, 6, 2000).catch(() => []);
  const restored: string[] = [];
  for (const entry of tree.filter((t) => !t.isDirectory && t.name !== RESTORED_MARKER)) {
    const rel = relativeTo(base, entry.path);
    if (!rel) continue;
    try {
      await platform.writeTextFile(`${root}\\${rel.replace(/\//g, '\\')}`, await platform.readTextFile(entry.path));
      restored.push(rel);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `${why} I had put back ${plural(restored.length, 'file')} before it stopped.` };
    }
  }
  await platform.createFile(`${base}\\${RESTORED_MARKER}`, `Restored by Atlas at ${new Date().toISOString()}\n`).catch(() => undefined);
  return { ok: true, restored };
}
