/**
 * Storage — what's using the space inside a folder, and clearing it out.
 *
 * `system.disk` (built before this phase) says how full a *drive* is; this
 * pack answers the question behind "why is my C: drive full", which is what's
 * using the space inside one *folder*. Two more properties on top of the ones
 * `net.rs`/`network-skills.ts` established:
 *
 * 6. **A number that might be wrong is worse than an honest partial one.** A
 *    folder can hold more than can be walked in bounded time — `folder_size`
 *    and `largest_files` both cap how much they'll visit and say so rather
 *    than silently returning a number for only part of the tree.
 * 7. **Emptying a folder needs no new platform method at all.** It's built
 *    entirely from `listDir` (what's directly inside) and `deletePath`
 *    (already routes through the OS recycle bin, per `platform.rs`) — the
 *    two primitives this port already had, composed rather than duplicated.
 */

import type { FileEntry, KnownFolder, Platform, Skill } from '@atlas/core';

const KNOWN_FOLDERS: readonly KnownFolder[] = [
  'home',
  'downloads',
  'documents',
  'desktop',
  'pictures',
  'music',
  'videos',
];

/** "downloads" (a known-folder name) or a literal path — resolved either way. */
async function resolveFolder(platform: Platform, raw: string): Promise<string | null> {
  const trimmed = raw.trim();
  const known = trimmed.toLowerCase().replace(/\s+folder$/, '') as KnownFolder;
  if (KNOWN_FOLDERS.includes(known)) {
    try {
      return await platform.knownFolder!(known);
    } catch {
      return null;
    }
  }
  return trimmed || null;
}

/** Byte counts as people say them: "4.7 GB", not "5046586572". */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function createStorageSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'storage.folderSize',
    label: 'Folder size',
    icon: '💾',
    domain: 'files',
    description: 'How much space a folder is using, recursively.',
    needs: ['storage'],
    risk: 'safe',
    examples: ['how big is my downloads folder', "what's the size of my documents folder"],
    params: {
      path: { type: 'string', required: true, description: 'a known folder name or a path' },
    },
    async run(args) {
      const raw = String(args.path ?? '');
      const path = await resolveFolder(platform, raw);
      if (!path) return { ok: false, error: `I couldn’t find “${raw}”.` };

      const size = await platform.folderSize?.(path);
      if (!size) return { ok: false, error: `I couldn’t measure ${path}.` };

      const note = size.truncated
        ? ' (there was too much there to fully measure, so this is a partial count)'
        : '';
      return {
        ok: true,
        message: `${path} is using ${formatBytes(size.totalBytes)} across ${size.fileCount.toLocaleString()} files${note}.`,
        data: size,
      };
    },
  });

  skills.push({
    id: 'storage.largestFiles',
    label: 'Largest files in a folder',
    icon: '💾',
    domain: 'files',
    description: 'The biggest files inside a folder, most-bytes first.',
    needs: ['storage'],
    risk: 'safe',
    examples: ['what are the largest files in my downloads folder', 'find large files in documents'],
    params: {
      path: { type: 'string', required: true, description: 'a known folder name or a path' },
      limit: { type: 'number', default: 10, description: 'how many to show' },
    },
    async run(args, ctx) {
      const raw = String(args.path ?? '');
      const path = await resolveFolder(platform, raw);
      if (!path) return { ok: false, error: `I couldn’t find “${raw}”.` };

      const limit = Number(args.limit ?? 10);
      const result = await platform.largestFiles?.(path, limit);
      if (!result) return { ok: false, error: `I couldn’t read ${path}.` };
      if (!result.files.length) return { ok: true, message: `Nothing in ${path}.` };

      ctx.showResults?.(
        result.files.map((f) => ({
          title: f.name,
          subtitle: formatBytes(f.sizeBytes),
          icon: '📄',
          payload: f,
        })),
        {
          title: `${result.files.length} largest file${result.files.length === 1 ? '' : 's'} in ${path}`,
          subtitle: result.truncated ? 'partial — there was too much to fully scan' : undefined,
        },
      );
      return { ok: true, spoken: true, message: '' };
    },
  });

  skills.push({
    id: 'storage.emptyFolder',
    label: 'Empty a folder',
    icon: '🗑️',
    domain: 'files',
    description: 'Send everything directly inside a folder to the recycle bin. The folder itself stays.',
    needs: ['storage', 'fs'],
    // Reversible through the recycle bin, but it touches every item in the
    // folder at once — the same "does this change something closing a window
    // won't undo" test the rest of this codebase uses, and the answer here is
    // "not without going to the recycle bin for it", which is a confirm.
    risk: 'confirm',
    examples: ['empty my downloads folder', 'clear out the temp folder'],
    params: {
      path: { type: 'string', required: true, description: 'a known folder name or a path' },
    },
    async run(args) {
      const raw = String(args.path ?? '');
      const path = await resolveFolder(platform, raw);
      if (!path) return { ok: false, error: `I couldn’t find “${raw}”.` };

      const entries: FileEntry[] = (await platform.listDir?.(path, 500)) ?? [];
      if (!entries.length) return { ok: true, message: `${path} is already empty.` };
      if (entries.length >= 500) {
        return {
          ok: false,
          error: `${path} has too many items for me to empty safely in one go.`,
        };
      }

      let moved = 0;
      for (const entry of entries) {
        // One failure (a file in use, a permission the account doesn't have)
        // must not stop the rest — the count at the end says exactly what
        // happened rather than claiming an all-or-nothing result that didn't.
        if (await platform.deletePath?.(entry.path)) moved += 1;
      }

      if (moved === entries.length) {
        return { ok: true, message: `Sent all ${moved} items in ${path} to the recycle bin.` };
      }
      if (moved === 0) {
        return { ok: false, error: `Couldn’t remove anything in ${path}.` };
      }
      return {
        ok: true,
        message: `Sent ${moved} of ${entries.length} items in ${path} to the recycle bin.`,
      };
    },
  });

  return skills;
}
