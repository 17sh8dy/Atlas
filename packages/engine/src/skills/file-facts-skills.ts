/**
 * `files.facts` — answers to questions about the files on this PC (docs: src/general/file-facts.ts).
 *
 * Read-only and bounded. It uses only what the platform already offers (`listDir`, `pathInfo`, `folderSize`,
 * `systemInfo`), so it can look only where Atlas is already allowed to look; a place outside Allowed Folders
 * comes back as the usual "outside the folders Atlas can touch" error, which the executor turns into the
 * "Add it?" offer. Where a number is partial (a folder bigger than one listing can hold, a walk that hit its
 * cap) the answer says so instead of presenting it as complete.
 */

import type { FileEntry, KnownFolder, Platform, Skill } from '@atlas/core';

/** `listDir` returns at most this many entries (the native side caps it). A full page means "at least". */
const PAGE = 500;

const KNOWN: readonly string[] = [
  'home',
  'downloads',
  'documents',
  'desktop',
  'pictures',
  'music',
  'videos',
];

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === 'string' ? e : '';
}

function parentOf(path: string): { dir: string; name: string } | null {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (cut < 0) return null;
  const dir = trimmed.slice(0, cut + 1).replace(/^([a-z]:)$/i, '$1\\');
  const name = trimmed.slice(cut + 1);
  return name ? { dir: /^[a-z]:[\\/]$/i.test(dir) ? dir : dir.replace(/[\\/]+$/, ''), name } : null;
}

export function createFileFactSkills(platform: Platform): Skill[] {
  async function resolve(raw: string): Promise<string | null> {
    const t = raw.trim();
    if (KNOWN.includes(t.toLowerCase())) {
      try {
        return (await platform.knownFolder?.(t.toLowerCase() as KnownFolder)) ?? null;
      } catch {
        return null;
      }
    }
    return t || null;
  }

  async function list(path: string): Promise<FileEntry[]> {
    return (await platform.listDir!(path, PAGE)) ?? [];
  }

  const skill: Skill = {
    id: 'files.facts',
    label: 'Questions about files and folders',
    icon: '🗂️',
    domain: 'files',
    description:
      'Answers questions about the files on this PC: how many folders or files are in a place, the newest/oldest/largest file, whether something exists, when it last changed, and which drives there are.',
    needs: ['fs'],
    risk: 'safe',
    examples: [
      'how many folders are in D:\\Dev',
      'how many files are in my downloads folder',
      "what's the newest file in D:\\Dev",
      'does D:\\Dev\\Atlas exist',
      'what drives do I have',
    ],
    params: {
      op: {
        type: 'string',
        required: true,
        enum: ['count', 'list', 'extreme', 'exists', 'modified', 'drives'],
        description: 'what is being asked',
      },
      path: {
        type: 'string',
        description: 'a folder path or a known-folder name such as downloads',
      },
      thing: {
        type: 'string',
        enum: ['folders', 'files', 'items', 'ext'],
        description: 'what to count or look at',
      },
      exts: { type: 'string', description: 'comma-separated file extensions, for thing=ext' },
      label: { type: 'string', description: 'what to call those files in the answer' },
      which: {
        type: 'string',
        enum: ['newest', 'oldest', 'largest', 'smallest'],
        description: 'for op=extreme',
      },
      name: { type: 'string', description: 'a file or folder name to look for, for op=exists' },
      deep: {
        type: 'string',
        enum: ['true', 'false'],
        description: 'count everything underneath too (slower on a big folder)',
      },
    },
    async run(args, ctx) {
      const op = String(args.op ?? '');

      if (op === 'drives') {
        const info = await platform.systemInfo?.();
        if (!info?.disks.length) return { ok: false, error: "I couldn't read the drive list." };
        const rows = info.disks.map(
          (d) =>
            `• ${d.mount} — ${bytes(d.totalBytes - d.usedBytes)} free of ${bytes(d.totalBytes)}`,
        );
        return {
          ok: true,
          message: `You have ${plural(info.disks.length, 'drive')}:\n${rows.join('\n')}`,
          data: info.disks,
        };
      }

      const path = await resolve(String(args.path ?? ''));
      if (!path) return { ok: false, error: `I couldn't tell which folder you meant.` };

      if (op === 'exists') {
        const name = String(args.name ?? '').trim();
        try {
          if (name) {
            const hit = (await list(path)).find((e) => e.name.toLowerCase() === name.toLowerCase());
            return {
              ok: true,
              message: hit
                ? `Yes — “${hit.name}” is ${hit.isDirectory ? 'a folder' : 'a file'} in ${path}.`
                : `No, there's nothing called “${name}” directly in ${path}.`,
            };
          }
          // The path itself.
          try {
            await list(path);
            return { ok: true, message: `Yes — ${path} exists, and it's a folder.` };
          } catch (e) {
            const why = messageOf(e);
            if (/outside the folders/i.test(why)) return { ok: false, error: why };
            const up = parentOf(path);
            if (up) {
              const hit = (await list(up.dir)).find(
                (x) => x.name.toLowerCase() === up.name.toLowerCase(),
              );
              return {
                ok: true,
                message: hit
                  ? `Yes — ${path} exists, and it's ${hit.isDirectory ? 'a folder' : 'a file'}.`
                  : `No — I don't see ${path}.`,
              };
            }
            return { ok: true, message: `No — I don't see ${path}.` };
          }
        } catch (e) {
          const why = messageOf(e);
          if (/outside the folders/i.test(why)) return { ok: false, error: why };
          return { ok: true, message: `No — I couldn't find ${path}.` };
        }
      }

      if (op === 'modified') {
        try {
          const info = await platform.pathInfo?.(path);
          if (!info?.modifiedAt)
            return { ok: false, error: `I couldn't read when ${path} changed.` };
          return { ok: true, message: `${path} was last changed on ${when(info.modifiedAt)}.` };
        } catch (e) {
          const why = messageOf(e);
          return {
            ok: false,
            error: /outside the folders/i.test(why) ? why : `I couldn't find ${path}.`,
          };
        }
      }

      let entries: FileEntry[];
      try {
        entries = await list(path);
      } catch (e) {
        const why = messageOf(e);
        if (/outside the folders/i.test(why)) return { ok: false, error: why };
        if (/isn.t a folder/i.test(why))
          return { ok: false, error: `${path} is a file, not a folder.` };
        return { ok: false, error: `I couldn't open ${path}.` };
      }
      const capped = entries.length >= PAGE;
      const atLeast = capped ? 'at least ' : '';
      const folders = entries.filter((e) => e.isDirectory);
      const files = entries.filter((e) => !e.isDirectory);

      if (op === 'count') {
        const thing = String(args.thing ?? 'items');
        let direct: string;
        if (thing === 'folders')
          direct = `There are ${atLeast}${plural(folders.length, 'folder')} directly inside ${path}.`;
        else if (thing === 'files')
          direct = `There are ${atLeast}${plural(files.length, 'file')} directly inside ${path}.`;
        else if (thing === 'ext') {
          const exts = String(args.exts ?? '')
            .split(',')
            .map((x) => x.trim().toLowerCase().replace(/^\./, ''))
            .filter(Boolean);
          const n = files.filter((f) => exts.includes(f.ext)).length;
          direct = `There ${n === 1 ? 'is' : 'are'} ${atLeast}${n.toLocaleString('en-US')} ${String(args.label ?? 'matching files')} directly inside ${path}. (I only looked at that folder itself, not the folders inside it.)`;
        } else
          direct = `There are ${atLeast}${plural(entries.length, 'item')} directly inside ${path}: ${plural(folders.length, 'folder')} and ${plural(files.length, 'file')}.`;

        // Everything underneath, so “how many” has the number the person may have meant too.
        let total = '';
        // A big tree takes seconds to walk, so that is done only when asked for ("in total", "including subfolders").
        const deep = String(args.deep) === 'true';
        if (thing !== 'ext' && deep && platform.folderSize) {
          try {
            const size = await platform.folderSize(path);
            const more = size.truncated
              ? ' (a partial count: the folder is too big to finish in time)'
              : '';
            if (thing === 'folders' && size.folderCount > folders.length)
              total = ` Counting everything inside them, there are ${plural(size.folderCount, 'folder')} in total${more}.`;
            else if (thing === 'files' && size.fileCount > files.length)
              total = ` Counting everything inside the folders too, there are ${plural(size.fileCount, 'file')} in total${more}.`;
            else if (thing === 'items')
              total = ` In total, counting everything inside the folders, that's ${plural(size.folderCount, 'folder')} and ${plural(size.fileCount, 'file')}${more}.`;
          } catch {
            /* the direct count stands on its own */
          }
        }
        const note = capped
          ? ' (this folder holds more than I can list at once, so these counts are lower bounds)'
          : '';
        return {
          ok: true,
          message: `${direct}${total}${note}`,
          data: { folders: folders.length, files: files.length },
        };
      }

      if (op === 'list') {
        const wantFolders = String(args.thing) === 'folders';
        const pool = wantFolders ? folders : files;
        const noun = wantFolders ? 'folder' : 'file';
        if (!pool.length)
          return { ok: true, message: `There are no ${noun}s directly inside ${path}.` };
        ctx.showResults?.(
          pool.map((e) => ({
            title: e.name,
            subtitle: e.isDirectory ? 'folder' : bytes(e.sizeBytes ?? 0),
            icon: e.isDirectory ? '📁' : '📄',
            payload: e,
          })),
          {
            title: `${atLeast}${plural(pool.length, noun)} in ${path}`,
            subtitle: capped
              ? 'partial — this folder holds more than I can list at once'
              : undefined,
          },
        );
        return { ok: true, spoken: true, message: '' };
      }

      if (op === 'extreme') {
        const which = String(args.which ?? 'newest');
        const thing = String(args.thing ?? 'items');
        const pool = thing === 'folders' ? folders : thing === 'files' ? files : entries;
        if (!pool.length)
          return {
            ok: true,
            message: `There ${thing === 'folders' ? 'are no folders' : thing === 'files' ? 'are no files' : 'is nothing'} directly in ${path}.`,
          };
        let pick: FileEntry | undefined;
        let detail = '';
        if (which === 'largest' || which === 'smallest') {
          const sized = pool.filter((e) => !e.isDirectory && typeof e.sizeBytes === 'number');
          if (!sized.length)
            return {
              ok: false,
              error: `Folder sizes need a full scan; say “largest folders in ${path}” for that.`,
            };
          sized.sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
          pick = which === 'largest' ? sized[sized.length - 1] : sized[0];
          detail = pick ? ` (${bytes(pick.sizeBytes ?? 0)})` : '';
        } else {
          const dated = pool.filter((e) => typeof e.modifiedAt === 'number');
          if (!dated.length) return { ok: false, error: "I couldn't read the dates there." };
          dated.sort((a, b) => (a.modifiedAt ?? 0) - (b.modifiedAt ?? 0));
          pick = which === 'newest' ? dated[dated.length - 1] : dated[0];
          detail = pick?.modifiedAt ? ` (changed ${when(pick.modifiedAt)})` : '';
        }
        if (!pick) return { ok: false, error: "I couldn't work that out." };
        const kind = pick.isDirectory ? 'folder' : 'file';
        const caveat = capped
          ? ' This is from the first part of a very large folder, so it may not be the true answer.'
          : '';
        return {
          ok: true,
          message: `The ${which} ${thing === 'items' ? kind : kind} in ${path} is “${pick.name}”${detail}.${caveat}`,
          data: pick,
        };
      }

      return { ok: false, error: "I didn't understand what to look up." };
    },
  };
  return [skill];
}
