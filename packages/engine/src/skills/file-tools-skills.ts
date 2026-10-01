/**
 * Zip and unzip, duplicate files, what changed, file attributes, copy a path.
 *
 * Every one takes a *spoken* target ("downloads", "notes.txt in documents",
 * "my work folder") and resolves it through `locate.ts`, so nobody has to type
 * `C:\Users\…` to use them. A target that could be two things is reported, not
 * guessed.
 *
 * Risk follows consequence. Zipping and unzipping only ever create something
 * new beside what is there (never overwriting, never deleting the source), so
 * they are `safe`. Finding duplicates and listing changes are read-only and
 * never offer to delete anything — "delete the copies" is a separate request,
 * with its own confirmation, about named files. Changing hidden/read-only
 * touches an existing file, so asks.
 */

import type { Memory, Platform, ResultRow, Skill } from '@atlas/core';
import { resolveTarget } from './locate';

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

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

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

export function createFileToolsSkills(platform: Platform, memory?: Memory): Skill[] {
  const skills: Skill[] = [];
  const locate = (spec: unknown) => resolveTarget(platform, memory, String(spec ?? ''));

  skills.push({
    id: 'files.zip',
    label: 'Zip a file or folder',
    icon: '🗜️',
    domain: 'files',
    description:
      'Compress a file or folder into a new .zip beside it. Never overwrites, and leaves the original alone.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['zip my downloads folder', 'zip report.docx in documents'],
    params: { target: { type: 'string', required: true, description: 'what to zip, in words or a path' } },
    async run(args, ctx) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      try {
        const out = await platform.zipPath!(t.path);
        ctx.showResults?.(
          [
            {
              title: basename(out),
              subtitle: out,
              icon: '🗜️',
              payload: { path: out },
              actions: [{ label: 'Show in folder', skill: 'files.reveal', args: { path: out } }],
            },
          ],
          { title: 'Zipped', subtitle: basename(t.path) },
        );
        return { ok: true, spoken: true, message: `🗜️ Zipped ${basename(t.path)} → ${basename(out)}`, data: out };
      } catch (e) {
        return fail(e, `I couldn't zip ${basename(t.path)}.`);
      }
    },
  });

  skills.push({
    id: 'files.unzip',
    label: 'Unzip',
    icon: '📂',
    domain: 'files',
    description:
      'Extract a .zip into a new folder beside it. Never overwrites, refuses archives that try to write outside that folder or that are suspiciously large.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['unzip photos.zip in downloads'],
    params: { target: { type: 'string', required: true, description: 'the .zip, in words or a path' } },
    async run(args, ctx) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      try {
        const out = await platform.unzipPath!(t.path);
        ctx.showResults?.(
          [
            {
              title: basename(out),
              subtitle: out,
              icon: '📂',
              payload: { path: out },
              actions: [
                { label: 'Open', skill: 'files.open', args: { path: out } },
                { label: 'Show in folder', skill: 'files.reveal', args: { path: out } },
              ],
            },
          ],
          { title: 'Unzipped', subtitle: basename(t.path) },
        );
        return { ok: true, spoken: true, message: `📂 Unzipped ${basename(t.path)} → ${basename(out)}`, data: out };
      } catch (e) {
        return fail(e, `I couldn't unzip ${basename(t.path)}.`);
      }
    },
  });

  skills.push({
    id: 'files.duplicates',
    label: 'Find duplicate files',
    icon: '👯',
    domain: 'files',
    description:
      'Find files with identical contents in a folder (and what they waste). Read-only — it never deletes anything.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['find duplicate files in downloads'],
    params: { target: { type: 'string', required: true, description: 'the folder to look in' } },
    async run(args, ctx) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      try {
        const found = await platform.findDuplicates!(t.path);
        if (!found.groups.length) {
          return {
            ok: true,
            message: `👯 No duplicate files in ${basename(t.path)}${found.truncated ? ' (I only got through part of it)' : ''}.`,
          };
        }
        // One row per file, labelled with its set, so "which of these are the same" is readable.
        const rows: ResultRow[] = found.groups
          .flatMap((g, gi) =>
            g.paths.map((p, i) => ({
              title: basename(p),
              subtitle: `set ${gi + 1} · copy ${i + 1} of ${g.paths.length} · ${formatBytes(g.sizeBytes)} · ${p}`,
              icon: '📄',
              payload: { path: p },
              actions: [
                { label: 'Show in folder', skill: 'files.reveal', args: { path: p } },
                { label: 'Open', skill: 'files.open', args: { path: p } },
              ],
            })),
          )
          .slice(0, 40);
        ctx.showResults?.(rows, {
          title: `Duplicates in ${basename(t.path)}`,
          subtitle: `${found.groups.length} set${found.groups.length === 1 ? '' : 's'} · ${formatBytes(found.wastedBytes)} wasted${found.truncated ? ' · partial' : ''}`,
        });
        return {
          ok: true,
          spoken: true,
          message: `👯 ${found.groups.length} set${found.groups.length === 1 ? '' : 's'} of duplicates in ${basename(t.path)}, about ${formatBytes(found.wastedBytes)} wasted. I haven't touched any of them.`,
          data: found,
        };
      } catch (e) {
        return fail(e, 'I couldn\'t look for duplicates there.');
      }
    },
  });

  skills.push({
    id: 'files.recent',
    label: 'What changed in a folder',
    icon: '🕘',
    domain: 'files',
    description: 'Files changed in a folder recently (default the last 24 hours), newest first.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['what changed in downloads today', 'what changed in documents this week'],
    params: {
      target: { type: 'string', required: true, description: 'the folder' },
      hours: { type: 'number', default: 24, description: 'how far back, in hours' },
    },
    async run(args, ctx) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      const hours = Math.min(24 * 365, Math.max(1, Math.round(Number(args.hours ?? 24))));
      try {
        const changed = await platform.recentChanges!(t.path, hours, 25);
        const span = hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
        if (!changed.length) return { ok: true, message: `🕘 Nothing in ${basename(t.path)} has changed in the last ${span}.` };
        ctx.showResults?.(
          changed.map<ResultRow>((f) => ({
            title: f.name,
            subtitle: `${when(f.modifiedAt)} · ${formatBytes(f.sizeBytes)}`,
            icon: '📄',
            payload: f,
            actions: [
              { label: 'Open', skill: 'files.open', args: { path: f.path } },
              { label: 'Show in folder', skill: 'files.reveal', args: { path: f.path } },
            ],
          })),
          { title: `Changed in ${basename(t.path)}`, subtitle: `last ${span} · ${changed.length} file${changed.length === 1 ? '' : 's'}` },
        );
        return { ok: true, spoken: true, message: `🕘 ${changed.length} file${changed.length === 1 ? '' : 's'} changed in ${basename(t.path)} in the last ${span}.`, data: changed };
      } catch (e) {
        return fail(e, "I couldn't look at that folder.");
      }
    },
  });

  skills.push({
    id: 'files.attributes',
    confirmAs: (a) => { const t = String(a.target ?? 'that file'); return a.hidden === true ? `hide ${t}` : a.hidden === false ? `unhide ${t}` : a.readOnly === true ? `make ${t} read-only` : a.readOnly === false ? `make ${t} editable` : `check ${t}`; },
    label: 'Hide, unhide or protect a file',
    icon: '🙈',
    domain: 'files',
    description:
      'Say whether a file is hidden or read-only, or hide/unhide it and make it read-only or editable. System files are refused.',
    needs: ['fs'],
    risk: 'confirm',
    // Reading an attribute changes nothing, so it does not ask.
    riskFor: (args) => (args.hidden === undefined && args.readOnly === undefined ? 'safe' : undefined),
    examples: ['hide secret.txt on the desktop', 'make notes.txt read only', 'is notes.txt hidden'],
    params: {
      target: { type: 'string', required: true, description: 'the file or folder' },
      hidden: { type: 'boolean', required: false, description: 'true to hide, false to unhide' },
      readOnly: { type: 'boolean', required: false, description: 'true to protect, false to allow editing' },
    },
    async run(args) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      const hidden = args.hidden === undefined ? null : Boolean(args.hidden);
      const readOnly = args.readOnly === undefined ? null : Boolean(args.readOnly);
      try {
        const changing = !(hidden === null && readOnly === null);
        const before = changing ? await platform.fileAttributes!(t.path) : null;
        const a = changing ? await platform.setFileAttributes!(t.path, readOnly, hidden) : await platform.fileAttributes!(t.path);
        const state = [a.hidden ? 'hidden' : 'visible', a.readOnly ? 'read-only' : 'editable'].join(', ');
        return {
          ok: true,
          message: `🙈 ${basename(t.path)} is ${state}.`,
          data: a,
          ...(before ? { undo: { skill: 'files.attributes', args: { target: t.path, hidden: before.hidden, readOnly: before.readOnly }, label: `${basename(t.path)} as it was` } } : {}),
        };
      } catch (e) {
        return fail(e, `I couldn't change ${basename(t.path)}.`);
      }
    },
  });

  skills.push({
    id: 'files.compare',
    label: 'Compare two files',
    icon: '⚖️',
    domain: 'files',
    description: 'Say whether two files are identical, and for text files show the first lines that differ. Read-only.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['compare notes.txt and notes backup.txt in documents'],
    params: {
      a: { type: 'string', required: true, description: 'the first file' },
      b: { type: 'string', required: true, description: 'the second file' },
    },
    async run(args) {
      const a = await locate(args.a);
      if (!a.ok) return { ok: false, error: a.error };
      // "X and Y in documents": the second file is looked for where the first was found.
      let bSpec = String(args.b ?? '');
      if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(bSpec) && !/\s(?:in|on|from)\s/i.test(bSpec) && args.place) {
        bSpec = `${bSpec} in ${String(args.place)}`;
      }
      const b = await locate(bSpec);
      if (!b.ok) return { ok: false, error: b.error };
      if (a.path === b.path) return { ok: false, error: "That's the same file twice." };
      try {
        const c = await platform.compareFiles!(a.path, b.path);
        const names = `${basename(a.path)} and ${basename(b.path)}`;
        if (c.identical) return { ok: true, message: `⚖️ ${names} are identical (${formatBytes(c.sizeA)}).`, data: c };

        // For text, say where they differ — the first few lines, not a wall.
        let detail = '';
        if (platform.readTextFile && c.sizeA < 512 * 1024 && c.sizeB < 512 * 1024) {
          try {
            const [ta, tb] = await Promise.all([platform.readTextFile(a.path), platform.readTextFile(b.path)]);
            const la = ta.split(/\r?\n/);
            const lb = tb.split(/\r?\n/);
            const diffs: string[] = [];
            let differing = 0;
            for (let i = 0; i < Math.max(la.length, lb.length); i++) {
              if (la[i] !== lb[i]) {
                differing++;
                if (diffs.length < 5) diffs.push(`line ${i + 1}: “${(la[i] ?? '(missing)').slice(0, 60)}” → “${(lb[i] ?? '(missing)').slice(0, 60)}”`);
              }
            }
            detail = `\n${differing} line${differing === 1 ? '' : 's'} differ:\n${diffs.join('\n')}${differing > diffs.length ? `\n…and ${differing - diffs.length} more.` : ''}`;
          } catch {
            // Not plain text — the size comparison is all there is to say.
          }
        }
        return {
          ok: true,
          message: `⚖️ ${names} are different (${formatBytes(c.sizeA)} vs ${formatBytes(c.sizeB)}).${detail}`,
          data: c,
        };
      } catch (e) {
        return fail(e, "I couldn't compare those.");
      }
    },
  });

  skills.push({
    id: 'files.copyPath',
    label: 'Copy a file’s path',
    icon: '📋',
    domain: 'files',
    description: "Put a file or folder's full path on the clipboard.",
    needs: ['fs', 'clipboard'],
    risk: 'safe',
    examples: ['copy the path of notes.txt in documents'],
    params: { target: { type: 'string', required: true, description: 'the file or folder' } },
    async run(args) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      const ok = await platform.writeClipboard!(t.path);
      return ok
        ? { ok: true, message: `📋 Copied the path of ${basename(t.path)}:\n${t.path}`, data: t.path }
        : { ok: false, error: "I couldn't reach the clipboard." };
    },
  });

  return skills;
}
