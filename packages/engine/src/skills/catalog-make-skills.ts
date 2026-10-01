/**
 * Making new things from old ones, and tidying up (tool-catalog pass): duplicate a
 * file or folder, create a shortcut, and a two-step cleanup (review, then clean).
 *
 * Duplicate and shortcut only ever add something new — a free name, never an overwrite —
 * so they are `safe`, and each returns an undo that sends the new thing to the Recycle Bin.
 *
 * Cleanup is review → clean. `cleanup.review` only counts. `cleanup.clean` counts again,
 * shows the exact amounts, asks once, and the native side refuses if there is noticeably
 * more than was shown. Installers go to the Recycle Bin; scratch (temp, crash dumps) is
 * removed for good, and the question says so.
 */

import type { CleanupScan, Memory, Platform, Skill } from '@atlas/core';
import { resolveTarget, resolvePlace } from './locate';

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export const CLEANUP_KINDS = ['temp', 'crashdumps', 'installers'] as const;
export type CleanupKind = (typeof CLEANUP_KINDS)[number];

const KIND_LABEL: Record<CleanupKind, string> = {
  temp: 'old temp files',
  crashdumps: 'crash dumps',
  installers: 'old installers in Downloads',
};

export function createCatalogMakeSkills(platform: Platform, memory?: Memory): Skill[] {
  const skills: Skill[] = [];
  const locate = (spec: unknown) => resolveTarget(platform, memory, String(spec ?? ''));

  skills.push({
    id: 'files.duplicate',
    label: 'Duplicate a file or folder',
    icon: '👯',
    domain: 'files',
    description: 'Make a copy of a file or a whole folder right beside it, named “… - Copy”. Never overwrites.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['duplicate the folder D:\\Dev\\Notes', 'make a copy of report.docx in documents'],
    params: { target: { type: 'string', required: true, description: 'the file or folder, in words or a path' } },
    async run(args, ctx) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      try {
        const out = await platform.duplicatePath!(t.path);
        ctx.showResults?.(
          [{ title: basename(out), subtitle: out, icon: '👯', payload: { path: out }, actions: [{ label: 'Open', skill: 'files.open', args: { path: out } }, { label: 'Show in folder', skill: 'files.reveal', args: { path: out } }] }],
          { title: 'Copied', subtitle: basename(t.path) },
        );
        return {
          ok: true,
          spoken: true,
          message: `👯 Copied ${basename(t.path)} → ${basename(out)}`,
          data: out,
          undo: { skill: 'files.delete', args: { path: out }, label: `move ${basename(out)} to the Recycle Bin` },
        };
      } catch (e) {
        return fail(e, `I couldn't copy ${basename(t.path)}.`);
      }
    },
  });

  skills.push({
    id: 'files.createShortcut',
    label: 'Create a shortcut',
    icon: '🔗',
    domain: 'files',
    description: 'A shortcut to a file or folder, or to a web address, on your desktop (or another folder you name). Never overwrites.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['make a shortcut to D:\\Dev\\Atlas on my desktop', 'create a shortcut to https://github.com'],
    params: {
      target: { type: 'string', required: true, description: 'a file or folder (words or a path), or an https:// address' },
      where: { type: 'string', required: false, description: 'the folder to put it in; default the desktop' },
      name: { type: 'string', required: false, description: 'what to call it' },
    },
    async run(args, ctx) {
      const spec = String(args.target ?? '').trim();
      const whereSpec = String(args.where ?? '').trim() || 'desktop';
      // A named place ("desktop", "documents"), or any folder given as a path or by name.
      let place = await resolvePlace(platform, memory, whereSpec);
      if (!place || !place.ok) place = await locate(whereSpec);
      if (!place.ok) return { ok: false, error: place.error };
      if (place.isDirectory === false) return { ok: false, error: `${basename(place.path)} is a file — a shortcut has to go in a folder.` };
      try {
        let out: string;
        if (/^https?:\/\//i.test(spec)) {
          const host = (() => {
            try {
              return new URL(spec).hostname.replace(/^www\./, '');
            } catch {
              return 'Link';
            }
          })();
          out = await platform.createUrlShortcut!(spec, String(args.name ?? '').trim() || host, place.path);
        } else {
          const t = await locate(spec);
          if (!t.ok) return { ok: false, error: t.error };
          out = await platform.createShortcut!(t.path, place.path, args.name ? String(args.name) : undefined);
        }
        ctx.showResults?.(
          [{ title: basename(out), subtitle: out, icon: '🔗', payload: { path: out }, actions: [{ label: 'Show in folder', skill: 'files.reveal', args: { path: out } }] }],
          { title: 'Shortcut made' },
        );
        return {
          ok: true,
          spoken: true,
          message: `🔗 Made the shortcut ${basename(out)} in ${basename(place.path)}.`,
          data: out,
          undo: { skill: 'files.delete', args: { path: out }, label: `move ${basename(out)} to the Recycle Bin` },
        };
      } catch (e) {
        return fail(e, "I couldn't make that shortcut.");
      }
    },
  });

  const scanOf = async (kind: CleanupKind): Promise<CleanupScan> => platform.cleanupScan!(kind);

  skills.push({
    id: 'cleanup.review',
    label: 'Review what can be cleaned up',
    icon: '🧹',
    domain: 'files',
    description: 'How much space old temp files, crash dumps and old installers (a month or more, in Downloads) are taking. It only counts — nothing is removed until you ask to clean one.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['what can i clean up', 'review my temp files'],
    params: { kind: { type: 'string', required: false, enum: ['all', ...CLEANUP_KINDS], description: 'temp, crashdumps, installers, or all (default)' } },
    async run(args, ctx) {
      const asked = String(args.kind ?? 'all');
      const kinds: readonly CleanupKind[] = (CLEANUP_KINDS as readonly string[]).includes(asked) ? [asked as CleanupKind] : CLEANUP_KINDS;
      try {
        const scans = await Promise.all(kinds.map(async (k) => [k, await scanOf(k)] as const));
        const total = scans.reduce((n, [, s]) => n + s.bytes, 0);
        ctx.showResults?.(
          scans.map(([k, s]) => ({
            title: `${KIND_LABEL[k][0]!.toUpperCase()}${KIND_LABEL[k].slice(1)}`,
            subtitle: s.files ? `${plural(s.files, 'file')} · ${formatBytes(s.bytes)}${s.truncated ? ' (at least — too big to scan fully)' : ''} · ${s.recoverable ? 'goes to the Recycle Bin' : 'removed for good'}` : 'nothing to clean',
            icon: s.files ? '🧹' : '✨',
            payload: s,
            actions: s.files ? [{ label: 'Clean', skill: 'cleanup.clean', args: { kind: k } }] : [],
          })),
          { title: 'What can be cleaned up', subtitle: total ? `${formatBytes(total)} in all` : 'Nothing worth cleaning' },
        );
        return {
          ok: true,
          spoken: true,
          message: total ? `🧹 About ${formatBytes(total)} could be cleaned up. Say “clean my temp files” (or crash dumps, or old installers) to do one — I’ll show you the exact amount and ask first.` : '✨ There’s nothing worth cleaning up right now.',
          data: scans.map(([, s]) => s),
        };
      } catch (e) {
        return fail(e, "I couldn't review that.");
      }
    },
  });

  skills.push({
    id: 'cleanup.clean',
    label: 'Clean up temp files, crash dumps or old installers',
    icon: '🧹',
    domain: 'files',
    description: 'Remove old temp files (not touched for a day) or crash dumps for good, or send old installers (a month or more, in Downloads) to the Recycle Bin. It counts first, shows the exact amount and asks once.',
    needs: ['fs'],
    // It asks for itself, with the real numbers, so the generic yes/no is not asked on top.
    risk: 'safe',
    examples: ['clean my temp files', 'clean up old installers'],
    params: { kind: { type: 'string', required: true, enum: CLEANUP_KINDS, description: 'temp, crashdumps or installers' } },
    async run(args, ctx) {
      const kind = String(args.kind ?? '') as CleanupKind;
      if (!(CLEANUP_KINDS as readonly string[]).includes(kind)) return { ok: false, error: 'I can clean temp files, crash dumps or old installers.' };
      try {
        const s = await scanOf(kind);
        if (!s.files) return { ok: true, message: `✨ There are no ${KIND_LABEL[kind]} to clean.` };
        const sample = s.largest.slice(0, 3).map((i) => `${basename(i.path)} (${formatBytes(i.sizeBytes)})`).join(', ');
        const yes = await ctx.confirm(
          `Clean ${plural(s.files, 'file')} — ${KIND_LABEL[kind]}, ${formatBytes(s.bytes)}?`,
          `${s.recoverable ? 'They go to the Recycle Bin, so you can put them back.' : 'These are removed for good — they are scratch files that programs make again.'}${sample ? ` Biggest: ${sample}.` : ''}${s.truncated ? ' (There may be more than this.)' : ''}`,
        );
        if (!yes) return { ok: true, message: 'Okay — I left everything alone.' };
        const done = await platform.cleanupClean!(kind, s.files, s.bytes);
        return {
          ok: true,
          message: `🧹 Cleaned ${plural(done.removedFiles, 'file')}, ${formatBytes(done.removedBytes)}${done.recoverable ? ' (in the Recycle Bin)' : ''}.${done.skippedFiles ? ` ${plural(done.skippedFiles, 'file')} couldn’t be removed — usually because they’re in use.` : ''}`,
          data: done,
        };
      } catch (e) {
        return fail(e, "I couldn't clean that up.");
      }
    },
  });

  return skills;
}
