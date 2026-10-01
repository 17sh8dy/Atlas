/**
 * Making and shipping things: starting a project from a template, deploying
 * one, shrinking video, converting and resizing media, renaming many files at
 * once, and flushing the DNS cache.
 *
 * Every native operation behind these is closed — a fixed tool, an enumerated
 * choice, one validated name (see `devtools.rs` and `media_tools.rs`). Media
 * work only ever makes a *new* file beside the original, never replacing it.
 * Batch rename shows exactly what it will do on the confirmation card and never
 * overwrites: if any new name would collide with something, nothing is renamed.
 */

import type { Memory, Platform, Skill } from '@atlas/core';
import { resolveTarget } from './locate';

const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

const fmt = (b: number): string => {
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export const SCAFFOLD_TEMPLATES = ['vanilla', 'vanilla-ts', 'react', 'react-ts', 'vue', 'vue-ts', 'svelte', 'svelte-ts'] as const;

/** What a batch rename would do to one name. */
export interface RenameRule {
  find?: string;
  replace?: string;
  prefix?: string;
  suffix?: string;
  numbered?: boolean;
  lower?: boolean;
  upper?: boolean;
}

/** Apply a rule to a file name, keeping its extension unless the rule is about the whole name. */
export function renamed(name: string, rule: RenameRule, index: number): string {
  const dot = name.lastIndexOf('.');
  let stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  if (rule.find) stem = stem.split(rule.find).join(rule.replace ?? '');
  if (rule.lower) stem = stem.toLowerCase();
  if (rule.upper) stem = stem.toUpperCase();
  if (rule.prefix) stem = rule.prefix + stem;
  if (rule.suffix) stem = stem + rule.suffix;
  if (rule.numbered) stem = `${stem} ${String(index + 1).padStart(2, '0')}`;
  return stem + ext;
}

export function createCreatorSkills(platform: Platform, memory?: Memory): Skill[] {
  const skills: Skill[] = [];
  const locate = (spec: unknown) => resolveTarget(platform, memory, String(spec ?? ''));

  skills.push({
    id: 'net.flushDns',
    label: 'Flush the DNS cache',
    icon: '🧹',
    domain: 'system',
    description: 'Clear Windows\' DNS cache — the usual fix when one site will not load but others do.',
    needs: ['os'],
    risk: 'safe',
    examples: ['flush the dns cache'],
    params: {},
    async run() {
      try {
        return { ok: true, message: `🧹 ${await platform.flushDns!()}` };
      } catch (e) {
        return fail(e, "I couldn't flush the DNS cache.");
      }
    },
  });

  skills.push({
    id: 'project.scaffold',
    label: 'Start a new app',
    icon: '🏗️',
    domain: 'project',
    description:
      'Create a new web app from a Vite template (vanilla, react, vue or svelte, with or without TypeScript) in a new folder. Never touches a folder that exists.',
    needs: ['devtools'],
    risk: 'confirm',
    confirmAs: (a) => `create a new ${String(a.template ?? 'react')} app called ${String(a.name)} in ${String(a.where ?? 'your Documents')} (this downloads the template)`,
    examples: ['create a react app called my-app in documents'],
    params: {
      name: { type: 'string', required: true, description: 'the folder name: lowercase letters, digits, dashes' },
      template: { type: 'string', required: false, enum: [...SCAFFOLD_TEMPLATES], description: 'default react-ts' },
      where: { type: 'string', required: false, description: 'the folder to make it in; default Documents' },
    },
    async run(args) {
      const name = String(args.name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
      const template = String(args.template ?? 'react-ts');
      const where = await locate(args.where || 'documents');
      if (!where.ok) return { ok: false, error: where.error };
      try {
        const r = await platform.scaffoldProject!(where.path, name, template);
        if (!r.ok) return { ok: false, error: `Starting the app failed (exit ${r.exitCode ?? '?'}).\n${(r.stderr || r.stdout).split(/\r?\n/).filter(Boolean).slice(-6).join('\n')}` };
        return {
          ok: true,
          message: `🏗️ Created ${name} (${template}) in ${where.path}. Next: "use ${where.path}\\${name} as my project", then "install dependencies".`,
          data: `${where.path}\\${name}`,
        };
      } catch (e) {
        return fail(e, "I couldn't start that app.");
      }
    },
  });

  skills.push({
    id: 'project.deploy',
    label: 'Deploy the project',
    icon: '🚀',
    domain: 'project',
    description: 'Deploy the project to Vercel or Cloudflare with its own CLI, as you are already signed in. Publishes it.',
    needs: ['devtools'],
    risk: 'confirm',
    confirmAs: (a) => `deploy ${String(a.path ?? 'your current project')} to ${a.target === 'cloudflare' ? 'Cloudflare' : 'Vercel'} — this publishes it`,
    examples: ['deploy to vercel'],
    params: {
      path: { type: 'string', required: true, description: 'the project folder (defaults to your current project)' },
      target: { type: 'string', required: true, enum: ['vercel', 'cloudflare'], description: 'where to deploy' },
    },
    async run(args) {
      try {
        const r = await platform.deployProject!(String(args.path), String(args.target) as 'vercel' | 'cloudflare');
        const tail = (r.stdout + '\n' + r.stderr).split(/\r?\n/).filter((l) => l.trim()).slice(-8).join('\n');
        return r.ok ? { ok: true, message: `🚀 Deployed.\n${tail}`, data: r } : { ok: false, error: `The deploy failed (exit ${r.exitCode ?? '?'}).\n${tail}` };
      } catch (e) {
        return fail(e, 'The deploy failed to start.');
      }
    },
  });

  // ---- media -----------------------------------------------------------------------------------

  const sizeLine = (r: { output: string; inputBytes: number; outputBytes: number }) =>
    `${base(r.output)} (${fmt(r.outputBytes)}, was ${fmt(r.inputBytes)})`;

  skills.push({
    id: 'media.compress',
    label: 'Compress a video',
    icon: '🎞️',
    domain: 'files',
    description: 'Make a smaller copy of a video (small, balanced or high quality). The original is never changed. Needs ffmpeg.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['compress video.mp4 in downloads'],
    params: {
      target: { type: 'string', required: true, description: 'the video, in words or a path' },
      level: { type: 'string', required: false, enum: ['small', 'balanced', 'high'], description: 'default balanced' },
    },
    async run(args) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      try {
        const r = await platform.compressVideo!(t.path, String(args.level ?? 'balanced'));
        return { ok: true, message: `🎞️ Made ${sizeLine(r)}. The original is untouched.`, data: r };
      } catch (e) {
        return fail(e, "I couldn't compress that.");
      }
    },
  });

  skills.push({
    id: 'media.convert',
    label: 'Convert a file',
    icon: '🔄',
    domain: 'files',
    description:
      'Convert audio, video or a picture to another format (mp3, wav, flac, m4a, ogg, mp4, webm, gif, png, jpg, webp, bmp). Makes a new file; the original is untouched. Needs ffmpeg.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['convert song.wav to mp3 in downloads'],
    params: {
      target: { type: 'string', required: true, description: 'the file' },
      format: { type: 'string', required: true, description: 'the new format, e.g. mp3' },
    },
    async run(args) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      try {
        const r = await platform.convertMedia!(t.path, String(args.format).toLowerCase().replace(/^\./, ''));
        return { ok: true, message: `🔄 Made ${sizeLine(r)}.`, data: r };
      } catch (e) {
        return fail(e, "I couldn't convert that.");
      }
    },
  });

  skills.push({
    id: 'media.resizeImage',
    label: 'Resize a picture',
    icon: '📐',
    domain: 'files',
    description: 'Make a smaller or larger copy of a picture, by width in pixels or by percentage. The original is untouched. Needs ffmpeg.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['resize photo.jpg in pictures to 800 wide'],
    params: {
      target: { type: 'string', required: true, description: 'the picture' },
      width: { type: 'number', required: false, description: 'new width in pixels' },
      percent: { type: 'number', required: false, description: 'or a percentage of the current size' },
    },
    async run(args) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      const width = args.width ? Math.round(Number(args.width)) : null;
      const percent = args.percent ? Math.round(Number(args.percent)) : null;
      try {
        const r = await platform.resizeImage!(t.path, width, percent);
        return { ok: true, message: `📐 Made ${sizeLine(r)}.`, data: r };
      } catch (e) {
        return fail(e, "I couldn't resize that.");
      }
    },
  });

  // ---- batch rename ------------------------------------------------------------------------------

  skills.push({
    id: 'files.batchRename',
    label: 'Rename many files',
    icon: '🏷️',
    domain: 'files',
    description:
      'Rename every file in a folder by a rule: replace some text, add a prefix or suffix, number them, or change the case. Shows the exact changes first, and refuses if any new name would collide.',
    needs: ['fs'],
    // `safe` on purpose: the skill asks for itself, once, with the exact list of changes. A
    // generic card ahead of that one ("are you sure?") says less and makes it two questions.
    risk: 'safe',
    examples: ['rename the files in documents/atlaslivetest replacing alpha with item'],
    params: {
      target: { type: 'string', required: true, description: 'the folder' },
      find: { type: 'string', required: false, description: 'text to replace' },
      replace: { type: 'string', required: false, description: 'what to replace it with' },
      prefix: { type: 'string', required: false, description: 'text to add at the start' },
      suffix: { type: 'string', required: false, description: 'text to add before the extension' },
      numbered: { type: 'boolean', required: false, description: 'add 01, 02, … to each' },
      lower: { type: 'boolean', required: false, description: 'make names lowercase' },
      upper: { type: 'boolean', required: false, description: 'make names UPPERCASE' },
    },
    async run(args, ctx) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      const rule: RenameRule = {
        find: args.find ? String(args.find) : undefined,
        replace: args.replace !== undefined ? String(args.replace) : undefined,
        prefix: args.prefix ? String(args.prefix) : undefined,
        suffix: args.suffix ? String(args.suffix) : undefined,
        numbered: Boolean(args.numbered),
        lower: Boolean(args.lower),
        upper: Boolean(args.upper),
      };
      if (!rule.find && !rule.prefix && !rule.suffix && !rule.numbered && !rule.lower && !rule.upper) {
        return { ok: false, error: 'Tell me the rule: replace some text, add a prefix or suffix, number them, or change the case.' };
      }
      try {
        const entries = (await platform.listDir!(t.path, 500)).filter((e) => !e.isDirectory);
        if (!entries.length) return { ok: true, message: 'There are no files in that folder.' };
        if (entries.length > 200) return { ok: false, error: 'That is more than 200 files — I rename at most 200 at a time.' };
        const plan = entries.map((e, i) => ({ path: e.path, from: e.name, to: renamed(e.name, rule, i) })).filter((p) => p.from !== p.to);
        if (!plan.length) return { ok: true, message: 'None of those names would change.' };

        // Everything has to be safe before anything moves.
        const lowerTargets = new Set<string>();
        const existing = new Set(entries.map((e) => e.name.toLowerCase()));
        for (const p of plan) {
          if (/[\\/:*?"<>|]/.test(p.to) || !p.to.trim()) return { ok: false, error: `“${p.to}” isn't a name Windows allows, so I haven't renamed anything.` };
          const key = p.to.toLowerCase();
          const taken = lowerTargets.has(key) || (existing.has(key) && !plan.some((q) => q.from.toLowerCase() === key));
          if (taken) return { ok: false, error: `Two files would end up called “${p.to}”, so I haven't renamed anything.` };
          lowerTargets.add(key);
        }

        const preview = plan.slice(0, 8).map((p) => `${p.from} → ${p.to}`).join('\n');
        const more = plan.length > 8 ? `\n…and ${plan.length - 8} more` : '';
        const ok = await ctx.confirm(`⚠️ Rename ${plan.length} file${plan.length === 1 ? '' : 's'}?`, `In ${base(t.path)}:\n${preview}${more}`);
        if (!ok) return { ok: false, error: 'Okay — nothing renamed.' };

        // When one new name is another file's old name (a shift: 1→2, 2→3), going straight
        // would overwrite; so everything goes through a temporary name first.
        const overlap = plan.some((x) => plan.some((y) => y !== x && y.from.toLowerCase() === x.to.toLowerCase()));
        const dir = (path: string, name: string) => path.slice(0, path.length - name.length);
        const done: Array<{ path: string; from: string; to: string }> = [];
        if (overlap) {
          for (const x of plan) await platform.renamePath!(x.path, `${x.from}.atlas-tmp`);
          for (const x of plan) {
            await platform.renamePath!(`${dir(x.path, x.from)}${x.from}.atlas-tmp`, x.to);
            done.push(x);
          }
        } else {
          for (const x of plan) {
            await platform.renamePath!(x.path, x.to);
            done.push(x);
          }
        }
        return { ok: true, message: `🏷️ Renamed ${done.length} file${done.length === 1 ? '' : 's'} in ${base(t.path)}.`, data: done };
      } catch (e) {
        return fail(e, "I couldn't rename those.");
      }
    },
  });

  return skills;
}
