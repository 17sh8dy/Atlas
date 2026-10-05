/**
 * A Platform double over the REAL filesystem, for tests of tools that read and write a project.
 *
 * It makes the same promises the native layer does, because a test against a double that is looser
 * than the real thing proves nothing: `createFile` refuses to overwrite, `writeTextFile` refuses to
 * create, `dirTree` skips dependency / build folders and dot-folders (so a backup is never a "project
 * file"), and a file over the 256 KB read cap cannot be read.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { FileEntry, PathInfo, Platform, TreeEntry } from '@atlas/core';

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', '.venv', 'venv', '__pycache__', 'bin', 'obj', '.turbo', '.next', '.cache']);
const READ_CAP = 256 * 1024;

export function makeTempProject(files: Record<string, string>, prefix = 'atlas-project-'): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, text] of Object.entries(files)) {
    const target = join(root, ...rel.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text, 'utf8');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function diskPlatform(): Platform {
  const entry = (p: string, name: string, isDirectory: boolean): FileEntry => ({
    path: p,
    name,
    ext: isDirectory ? '' : (name.split('.').pop() ?? '').toLowerCase(),
    isDirectory,
  });

  /*
   * `path` is RELATIVE to the folder that was asked about, as the native `walk_tree` returns it
   * (it strips the root). An earlier version of this double returned absolute paths, which is
   * exactly why code that assumed absolute paths passed every test and found no files at all in
   * the real app. Dot-named entries are skipped at every level, files included, as the native one does.
   */
  const walk = (root: string, dir: string, maxDepth: number, cap: number, out: TreeEntry[], depth = 0) => {
    if (out.length >= cap || depth > maxDepth) return;
    for (const name of readdirSync(dir).sort()) {
      if (out.length >= cap) return;
      if (name.startsWith('.')) continue;
      const p = join(dir, name);
      const isDirectory = statSync(p).isDirectory();
      if (isDirectory && SKIP_DIRS.has(name)) continue;
      out.push({ path: relative(root, p), name, isDirectory, depth });
      if (isDirectory) walk(root, p, maxDepth, cap, out, depth + 1);
    }
  };

  return {
    pathInfo: async (p: string) => ({ exists: existsSync(p), isDirectory: existsSync(p) && statSync(p).isDirectory() }) as unknown as PathInfo,
    dirTree: async (cwd: string, depth = 3, max = 400) => {
      const out: TreeEntry[] = [];
      walk(cwd, cwd, Math.min(depth, 6), Math.min(max, 2000), out);
      return out;
    },
    listDir: async (p: string) => readdirSync(p).map((n) => entry(join(p, n), n, statSync(join(p, n)).isDirectory())),
    readTextFile: async (p: string) => {
      if (statSync(p).size > READ_CAP) throw new Error('that file is over the 256 KB read limit');
      return readFileSync(p, 'utf8');
    },
    writeTextFile: async (p: string, c: string) => {
      if (!existsSync(p)) throw new Error('that file does not exist');
      writeFileSync(p, c, 'utf8');
      return true;
    },
    createFile: async (p: string, c = '') => {
      if (existsSync(p)) throw new Error('already exists');
      writeFileSync(p, c, 'utf8');
      return true;
    },
    createFolder: async (p: string) => {
      mkdirSync(p, { recursive: true });
      return true;
    },
  } as unknown as Platform;
}

/** Every file under `root` (including dot-folders), as relative forward-slash path → text. */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const go = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) go(p);
      else out[relative(root, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  go(root);
  return out;
}
