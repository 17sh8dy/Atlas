/**
 * `project.recolor` / `project.recolorUndo` — change a project's colours with no model.
 *
 * "Switch the whole app look to red" is the kind of request that used to be answered with "I
 * couldn't reach your language model". For a project whose look lives in colours (every project
 * Atlas builds itself, and most small web or Electron apps) it never needed one: the maths is in
 * `recolor-plan.ts`, the disk rails are in `project-files.ts`, and this file joins them.
 *
 * It follows the same rails as every other bulk change in Atlas:
 *   1. A PREVIEW BEFORE ANYTHING IS WRITTEN. `preview` is read-only; it says which files and how
 *      many colours, and what it is deliberately leaving alone. Never softened by a mode.
 *   2. AN APPROVAL IS FOR WHAT WAS SHOWN. `run` re-derives the plan and refuses if the files changed
 *      in the meantime (the fingerprint on the card).
 *   3. NOTHING IS LOST. Every file is copied to `.atlas-backup\recolor-<time>\` BEFORE it is
 *      overwritten, and `project.recolorUndo` puts the latest set back.
 *
 * It writes only files that were READ, only with an extension that can hold a colour (css, html,
 * js/ts), and only inside folders Atlas is already allowed to use.
 */

import type { Platform, Skill, SkillContext } from '@atlas/core';
import { fingerprintOf } from './organize-plan';
import { hueName, kindOf, parseTargetHue, planRecolor, type RecolorPlan, type RecolorResult } from './recolor-plan';
import { BACKUP_DIR, backupThenWrite, baseName, plural, readProjectFiles, restoreLatestBackup, trimPath } from './project-files';

const LABEL = 'recolor';

export function createRecolorSkills(platform: Platform, current?: { set(path: string): Promise<void> }): Skill[] {
  type Built =
    | { error: string }
    | { root: string; hue: number; result: RecolorResult; fullPath: Map<string, string>; skipped: number };

  async function build(args: Record<string, unknown>): Promise<Built> {
    const root = trimPath(String(args.path ?? ''));
    if (!root) return { error: 'Which project should I recolour?' };
    const hue = parseTargetHue(String(args.color ?? ''));
    if (hue === null) {
      return { error: `I don't know the colour “${String(args.color ?? '').trim()}”. Try red, orange, yellow, green, teal, blue, purple or pink — or a hex like #e11d48.` };
    }
    const info = await platform.pathInfo?.(root).catch(() => null);
    if (info && !info.isDirectory) return { error: `${baseName(root)} is a file; point me at the project folder.` };

    const got = await readProjectFiles(platform, root, (p) => kindOf(p) !== null);
    if ('error' in got) return { error: got.error };
    const result = planRecolor(
      got.files.map((f) => ({ path: f.rel, text: f.text })),
      hue,
    );
    return { root, hue, result, fullPath: new Map(got.files.map((f) => [f.rel, f.path])), skipped: got.skipped };
  }

  const fingerprintFor = (plan: RecolorPlan) =>
    fingerprintOf(plan.files.map((f) => `${f.path}|${f.changed}|${f.after.length}`));

  const describe = (plan: RecolorPlan, skipped: number, target: string) => {
    const lines = [
      `${hueName(plan.from)} → ${target}: ${plural(plan.moved, 'colour')} in ${plural(plan.files.length, 'file')}.`,
      ...plan.files.slice(0, 8).map((f) => `• ${f.path} — ${plural(f.changed, 'colour')}`),
    ];
    if (plan.files.length > 8) lines.push(`• …and ${plan.files.length - 8} more`);
    if (plan.keptApart) {
      lines.push(`Left as they are: ${plural(plan.keptApart, 'colour')} that are a different colour on purpose (a warning, a success tick), and greys.`);
    }
    if (plan.notRewritten) lines.push(`I can't rewrite ${plural(plan.notRewritten, 'hsl() colour')}; those stay.`);
    if (skipped) lines.push(`${plural(skipped, 'file')} were too big or unreadable and are untouched.`);
    lines.push('Originals are saved to .atlas-backup in the project first, and “undo the recolor” puts them back.');
    return lines.join('\n');
  };

  const recolor: Skill = {
    id: 'project.recolor',
    label: 'Recolour a project',
    icon: '🎨',
    domain: 'project',
    description:
      "Change a project's whole colour scheme to another colour — red, blue, green, purple… — by rotating the colours of its own theme, keeping lightness and contrast. Warning/success colours and greys stay. Works on css, html and js/ts colours; saves a backup first and can be undone. No model needed.",
    needs: ['devtools'],
    // Rewrites many files at once: a confirm, always, never softened by a mode (see `Skill.preview`).
    risk: 'confirm',
    examples: ['make the whole app red', 'switch the look of D:\\Dev\\MyApp to blue', 'recolor my project green'],
    params: {
      path: { type: 'string', required: true, description: 'the project folder' },
      color: { type: 'string', required: true, description: 'the new colour: a name like red/blue/green, or a hex like #e11d48' },
    },

    async preview(args) {
      const built = await build(args);
      if ('error' in built) return { kind: 'refuse', error: built.error };
      const { result, hue, skipped } = built;
      if (result.kind === 'nothing') return { kind: 'nothing', message: nothingMessage(result, built.root) };
      return {
        kind: 'ask',
        question: `🎨 Recolour ${baseName(built.root)} to ${hueName(hue)}?`,
        detail: describe(result.plan, skipped, hueName(hue)),
        fingerprint: fingerprintFor(result.plan),
      };
    },

    async run(args, ctx: SkillContext) {
      const built = await build(args);
      if ('error' in built) return { ok: false, error: built.error };
      const { result, root, hue, fullPath } = built;
      if (result.kind === 'nothing') return { ok: true, message: nothingMessage(result, root) };
      const { plan } = result;

      if (ctx.approvedPreview !== undefined && ctx.approvedPreview !== fingerprintFor(plan)) {
        return {
          ok: false,
          error: "The project changed after I showed you the plan, so I didn't touch anything. Ask again and I'll show you what's there now.",
        };
      }

      const written = await backupThenWrite(
        platform,
        root,
        LABEL,
        plan.files.map((f) => ({ rel: f.path, path: fullPath.get(f.path)!, before: f.before, after: f.after })),
        ctx,
        'Recolouring',
      );
      if (!written.ok) return { ok: false, error: written.error };

      await current?.set(root).catch(() => undefined);
      return {
        ok: true,
        message: `Recoloured ${baseName(root)} to ${hueName(hue)}: ${plural(plan.moved, 'colour')} in ${plural(plan.files.length, 'file')}. Originals are in ${BACKUP_DIR}\\${baseName(written.backup)} — say “undo the recolor” to put them back.`,
        data: { path: root, backup: written.backup, files: written.done, moved: plan.moved },
      };
    },
  };

  const undo: Skill = {
    id: 'project.recolorUndo',
    label: 'Undo a recolour',
    icon: '↩️',
    domain: 'project',
    description: 'Put back the colours a project had before the last recolour, from the backup that was saved. Does nothing if there is no backup.',
    needs: ['devtools'],
    risk: 'confirm',
    examples: ['undo the recolor', 'put the old colours back'],
    params: { path: { type: 'string', required: true, description: 'the project folder' } },

    async run(args) {
      const root = trimPath(String(args.path ?? ''));
      if (!root) return { ok: false, error: 'Which project?' };
      const back = await restoreLatestBackup(platform, root, LABEL);
      if (!back.ok) return { ok: false, error: back.error };
      if ('none' in back) return { ok: true, message: `There is no recolour to undo in ${baseName(root)}.` };
      return {
        ok: true,
        message: `Put back the original colours in ${plural(back.restored.length, 'file')} (${back.restored.join(', ')}).`,
        data: { path: root, restored: back.restored },
      };
    },
  };

  return [recolor, undo];
}

function nothingMessage(result: { kind: 'nothing'; reason: 'no-colours' | 'already' | 'no-files'; from?: number }, root: string): string {
  const name = baseName(root);
  if (result.reason === 'already') {
    return `${name} already looks ${result.from === undefined ? 'like that' : hueName(result.from)} — nothing to change.`;
  }
  if (result.reason === 'no-colours') {
    return `I couldn't find a colour scheme to change in ${name} (no css, html or js colours). Changing how it looks beyond colours needs a model to write the code.`;
  }
  return `I found no css, html or script files in ${name} to recolour.`;
}
