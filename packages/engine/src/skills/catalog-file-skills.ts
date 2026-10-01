/**
 * Read-only file questions from the tool-catalog pass: a file's SHA-256, what is
 * inside a zip, files by extension / size / age, empty files and folders, and how
 * two folders differ.
 *
 * All `safe`: they only look. None of them offers to delete what it found — "delete
 * the empty folders" is a separate request about named things, with its own ask.
 */

import type { Memory, Platform, Skill } from '@atlas/core';
import { resolveTarget } from './locate';

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

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

const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function createCatalogFileSkills(platform: Platform, memory?: Memory): Skill[] {
  const skills: Skill[] = [];
  const locate = (spec: unknown) => resolveTarget(platform, memory, String(spec ?? ''));

  skills.push({
    id: 'files.hash',
    label: 'Hash a file',
    icon: '#️⃣',
    domain: 'files',
    description: 'The SHA-256 of a file — to check a download is the one that was published.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['sha256 of setup.exe in downloads', 'checksum of installer.msi in downloads'],
    params: { target: { type: 'string', required: true, description: 'the file, in words or a path' } },
    async run(args) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      try {
        const h = await platform.fileHash!(t.path);
        return { ok: true, message: `#️⃣ SHA-256 of ${basename(t.path)} (${formatBytes(h.sizeBytes)}):\n${h.sha256}`, data: h };
      } catch (e) {
        return fail(e, `I couldn't hash ${basename(t.path)}.`);
      }
    },
  });

  skills.push({
    id: 'files.listArchive',
    label: 'What is in a zip',
    icon: '🗜️',
    domain: 'files',
    description: 'List what a .zip contains without extracting anything.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['what is in photos.zip in downloads', 'list the contents of backup.zip in documents'],
    params: { target: { type: 'string', required: true, description: 'the .zip, in words or a path' } },
    async run(args, ctx) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      try {
        const a = await platform.listArchive!(t.path, 40);
        ctx.showResults?.(
          a.entries.map((e) => ({ title: e.name, subtitle: e.isDir ? 'folder' : formatBytes(e.sizeBytes), icon: e.isDir ? '📁' : '📄' })),
          { title: basename(t.path), subtitle: `${plural(a.totalEntries, 'item')} · ${formatBytes(a.totalBytes)} unpacked${a.totalEntries > a.entries.length ? ` · showing ${a.entries.length}` : ''}` },
        );
        return { ok: true, spoken: true, message: `🗜️ ${basename(t.path)} holds ${plural(a.totalEntries, 'item')}, ${formatBytes(a.totalBytes)} once unpacked.`, data: a };
      } catch (e) {
        return fail(e, `I couldn't read ${basename(t.path)}.`);
      }
    },
  });

  skills.push({
    id: 'files.search',
    label: 'Find files by type, size or age',
    icon: '🔎',
    domain: 'files',
    description: 'Files in a folder (and below it) that match an extension, a size, or an age — for example every PDF over 5 MB, or videos older than 90 days. Newest first.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['find all pdfs in downloads', 'find mp4 files bigger than 500 mb in videos'],
    params: {
      where: { type: 'string', required: true, description: 'the folder to look in, in words or a path' },
      ext: { type: 'string', required: false, description: 'file extension, without the dot' },
      minBytes: { type: 'number', required: false, description: 'at least this big' },
      maxBytes: { type: 'number', required: false, description: 'at most this big' },
      withinDays: { type: 'number', required: false, description: 'changed in the last N days' },
      olderDays: { type: 'number', required: false, description: 'not changed for N days' },
    },
    async run(args, ctx) {
      const t = await locate(args.where);
      if (!t.ok) return { ok: false, error: t.error };
      const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
      const q = {
        path: t.path,
        ext: args.ext ? String(args.ext) : undefined,
        minBytes: num(args.minBytes),
        maxBytes: num(args.maxBytes),
        modifiedWithinDays: num(args.withinDays),
        olderThanDays: num(args.olderDays),
        limit: 40,
      };
      if (q.ext === undefined && q.minBytes === undefined && q.maxBytes === undefined && q.modifiedWithinDays === undefined && q.olderThanDays === undefined) {
        return { ok: false, error: 'Say what to look for — a type (like pdf), a size, or an age.' };
      }
      try {
        const r = await platform.findFiles!(q);
        const what = [
          q.ext ? `.${q.ext.replace(/^\./, '')} files` : 'files',
          q.minBytes !== undefined ? `over ${formatBytes(q.minBytes)}` : '',
          q.maxBytes !== undefined ? `under ${formatBytes(q.maxBytes)}` : '',
          q.modifiedWithinDays !== undefined ? `changed in the last ${plural(q.modifiedWithinDays, 'day')}` : '',
          q.olderThanDays !== undefined ? `not changed for ${plural(q.olderThanDays, 'day')}` : '',
        ].filter(Boolean).join(' ');
        if (!r.total) return { ok: true, message: `🔎 No ${what} in ${basename(t.path)}${r.truncated ? ' (I stopped looking early — it is a big folder)' : ''}.` };
        ctx.showResults?.(
          r.items.map((f) => ({
            title: f.name,
            subtitle: `${formatBytes(f.sizeBytes)} · ${f.path}`,
            icon: '📄',
            payload: f,
            actions: [{ label: 'Open', skill: 'files.open', args: { path: f.path } }, { label: 'Show in folder', skill: 'files.reveal', args: { path: f.path } }],
          })),
          { title: `Found ${what}`, subtitle: `${plural(r.total, 'match', 'matches')} in ${basename(t.path)}${r.truncated ? ' · partial — too big to scan completely' : ''}` },
        );
        return { ok: true, spoken: true, message: `🔎 ${plural(r.total, 'match', 'matches')} for ${what} in ${basename(t.path)}${r.truncated ? ' (so far — the scan was cut short)' : ''}.`, data: r };
      } catch (e) {
        return fail(e, "I couldn't search there.");
      }
    },
  });

  skills.push({
    id: 'files.findEmpty',
    label: 'Find empty files and folders',
    icon: '🫥',
    domain: 'files',
    description: 'Empty files, empty folders, or both, in a folder and below it. It only lists them.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['find empty folders in documents', 'find empty files in downloads'],
    params: {
      where: { type: 'string', required: true, description: 'the folder to look in' },
      kind: { type: 'string', required: false, enum: ['files', 'folders', 'any'], description: 'files, folders, or both (default both)' },
    },
    async run(args, ctx) {
      const t = await locate(args.where);
      if (!t.ok) return { ok: false, error: t.error };
      const kind = (['files', 'folders', 'any'].includes(String(args.kind)) ? String(args.kind) : 'any') as 'files' | 'folders' | 'any';
      try {
        const r = await platform.findFiles!({ path: t.path, empty: kind, limit: 60 });
        const noun = kind === 'any' ? 'empty files or folders' : `empty ${kind}`;
        if (!r.total) return { ok: true, message: `🫥 No ${noun} in ${basename(t.path)}.` };
        ctx.showResults?.(
          r.items.map((f) => ({ title: f.name, subtitle: f.path, icon: f.isDir ? '📁' : '📄', payload: f, actions: [{ label: 'Show in folder', skill: 'files.reveal', args: { path: f.path } }] })),
          { title: `Empty in ${basename(t.path)}`, subtitle: `${plural(r.total, 'item')}${r.truncated ? ' · partial' : ''}` },
        );
        return { ok: true, spoken: true, message: `🫥 ${plural(r.total, 'item')}: ${noun} in ${basename(t.path)}. I haven’t touched them.`, data: r };
      } catch (e) {
        return fail(e, "I couldn't look there.");
      }
    },
  });

  skills.push({
    id: 'files.compareFolders',
    label: 'Compare two folders',
    icon: '⚖️',
    domain: 'files',
    description: 'Which files are in one folder and not the other, and which differ. Read-only.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['compare folders D:\\Dev\\A and D:\\Dev\\B'],
    params: {
      a: { type: 'string', required: true, description: 'the first folder' },
      b: { type: 'string', required: true, description: 'the second folder' },
    },
    async run(args, ctx) {
      const a = await locate(args.a);
      if (!a.ok) return { ok: false, error: a.error };
      const b = await locate(args.b);
      if (!b.ok) return { ok: false, error: b.error };
      if (a.path === b.path) return { ok: false, error: "That's the same folder twice." };
      try {
        const c = await platform.compareFolders!(a.path, b.path);
        const rows = [
          ...c.onlyInA.map((n) => ({ title: n, subtitle: `only in ${basename(a.path)}`, icon: '⬅️' })),
          ...c.onlyInB.map((n) => ({ title: n, subtitle: `only in ${basename(b.path)}`, icon: '➡️' })),
          ...c.different.map((n) => ({ title: n, subtitle: 'in both, but different', icon: '≠' })),
        ];
        if (!rows.length) return { ok: true, message: `⚖️ ${basename(a.path)} and ${basename(b.path)} have the same ${plural(c.same, 'file')}.${c.truncated ? ' (I stopped early — they are big.)' : ''}`, data: c };
        ctx.showResults?.(rows.slice(0, 80), { title: `${basename(a.path)} vs ${basename(b.path)}`, subtitle: `${plural(c.same, 'file')} the same${c.truncated ? ' · partial' : ''}` });
        return {
          ok: true,
          spoken: true,
          message: `⚖️ ${plural(c.onlyInA.length, 'file')} only in ${basename(a.path)}, ${plural(c.onlyInB.length, 'file')} only in ${basename(b.path)}, ${plural(c.different.length, 'file')} different, ${plural(c.same, 'file')} the same.`,
          data: c,
        };
      } catch (e) {
        return fail(e, "I couldn't compare those.");
      }
    },
  });

  return skills;
}
