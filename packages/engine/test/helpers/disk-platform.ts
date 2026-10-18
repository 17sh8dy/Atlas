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
import type { ChangeMeta, ChangeOutcome, ChangeRecord, FileEntry, PathInfo, Platform, TreeEntry } from '@atlas/core';

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

/**
 * The checkpoint store, with the SAME rules as `changes.rs`: a change is put back (or replaced by
 * the person's edit) only if the file still holds exactly what Atlas wrote, a side over the read cap
 * is refused whole, and the original stays the checkpoint through an edit. A double looser than the
 * native side would make the tests of the skills above it prove nothing.
 */
export function changeStore() {
  const records = new Map<string, ChangeRecord>();
  let counter = 0;
  const outcome = (ok: boolean, o: string, message: string) => ({ ok, outcome: o, message }) as ChangeOutcome;
  return {
    records,
    recordChange: async (c: { path: string; before: string; after: string; source: string; added: number; removed: number }) => {
      if (c.before.length > READ_CAP || c.after.length > READ_CAP) throw new Error('That file is too large to keep a checkpoint of.');
      const id = `chg-${(++counter).toString(16).padStart(4, '0')}`;
      records.set(id, {
        id,
        path: c.path,
        name: c.path.split(/[\\/]/).pop() ?? c.path,
        at: Date.now() + counter,
        status: 'applied',
        added: c.added,
        removed: c.removed,
        source: c.source,
        before: c.before,
        after: c.after,
      });
      return id;
    },
    getChange: async (id: string) => records.get(id) ?? null,
    listChanges: async (limit = 50): Promise<ChangeMeta[]> =>
      [...records.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, limit)
        .map(({ before: _b, after: _a, ...meta }) => meta),
    keepChange: async (id: string) => {
      const r = records.get(id);
      if (!r) return outcome(false, 'unknown', "I don't have that change any more.");
      if (r.status === 'reverted') return outcome(false, 'conflict', 'That change was already put back.');
      r.status = 'kept';
      return outcome(true, 'kept', 'Marked as kept.');
    },
    revertChange: async (id: string) => {
      const r = records.get(id);
      if (!r) return outcome(false, 'unknown', "I don't have that change any more.");
      if (r.status === 'reverted') return outcome(true, 'already', `${r.name} was already put back.`);
      if (!existsSync(r.path)) return outcome(false, 'missing', `${r.name} isn't there any more, so there is nothing to put back.`);
      const current = readFileSync(r.path, 'utf8');
      if (current === r.before) {
        r.status = 'reverted';
        return outcome(true, 'already', `${r.name} already holds what it did before the edit.`);
      }
      if (current !== r.after) {
        return outcome(false, 'conflict', `${r.name} has changed since Atlas edited it, so I left it alone. Nothing was overwritten.`);
      }
      writeFileSync(r.path, r.before, 'utf8');
      r.status = 'reverted';
      return outcome(true, 'reverted', `Put ${r.name} back as it was before Atlas edited it.`);
    },
    editChange: async (id: string, content: string) => {
      const r = records.get(id);
      if (!r) return outcome(false, 'unknown', "I don't have that change any more.");
      if (r.status === 'reverted') return outcome(false, 'conflict', "That change was already put back, so there is nothing of Atlas's left to edit.");
      if (!existsSync(r.path)) return outcome(false, 'missing', `${r.name} isn't there any more.`);
      if (readFileSync(r.path, 'utf8') !== r.after) {
        return outcome(false, 'conflict', `${r.name} has changed since Atlas edited it, so I left it alone. Nothing was overwritten.`);
      }
      writeFileSync(r.path, content, 'utf8');
      r.after = content;
      r.edited = true;
      return outcome(true, 'edited', `Saved your edit to ${r.name}. Undo still restores the original.`);
    },
  };
}

export function diskPlatform(): Platform {
  const checkpoints = changeStore();
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
    patchTextFile: async (p: string, find: string, replace: string, all = false) => {
      // The same refusals, in the same words, as the native `patch_text_file`.
      if (!existsSync(p)) throw new Error("That file doesn't exist.");
      const text = readFileSync(p, 'utf8');
      const parts = text.split(find);
      const n = parts.length - 1;
      if (n === 0) throw new Error("That text isn't in the file — nothing to replace.");
      if (n > 1 && !all) throw new Error(`That text appears ${n} times — pass more context to make it unique, or replaceAll.`);
      writeFileSync(p, all ? parts.join(replace) : parts[0] + replace + parts.slice(1).join(find), 'utf8');
      const count = all ? n : 1;
      return `Replaced ${count} occurrence${count === 1 ? '' : 's'}.`;
    },
    recordChange: checkpoints.recordChange,
    getChange: checkpoints.getChange,
    listChanges: checkpoints.listChanges,
    keepChange: checkpoints.keepChange,
    revertChange: checkpoints.revertChange,
    editChange: checkpoints.editChange,
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
