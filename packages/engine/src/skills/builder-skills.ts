/**
 * The builder's foundation: describe → build → CHECK → open a preview.
 *
 * “Build me a clicker game in D:\Dev\Clicker” already reached real working files (a template, no
 * model) or the developer agent (a model, every step through the usual gates). What was missing
 * between “built” and “opened” was a look at what was actually built. These two skills add it, and
 * remember what the last build was so the next step — change it — has something to refer to:
 *
 *   `project.check`   READ-ONLY. Is there something to open, does every file the page loads exist, does
 *                     each JSON file parse, does package.json point at real files. Runs nothing.
 *   `builder.status`  READ-ONLY. What Atlas last built, how, and how it checks out now.
 *
 * Neither adds a power. `project.check` is `dirTree` + `readTextFile` (what `project.stats` uses), and
 * the record is one remembered fact, in the same memory the “current project” lives in.
 *
 * 1.0.9 closes the loop:
 *
 *   `builder.change`  CONFIRMS. “make the button bigger”, “add a shop to it”: a snapshot of the project
 *                     first, then the developer agent makes ONLY that change (every one of its steps
 *                     through the usual gates), then the project is checked again and the answer says
 *                     what changed and whether it was verified. Needs a model — and says so plainly.
 *   `builder.revert`  CONFIRMS. Puts back the files as they were before the last change.
 *
 * The record keeps a short history of changes, so “what did you build” can say what happened since.
 * Nothing here has a power the developer agent did not already have; this is the glue that makes a
 * change one safe, undoable, checked step instead of an open-ended run.
 */

import type { Memory, Platform, Skill } from '@atlas/core';
import type { SkillRegistry } from './registry';
import { checkProject, formatCheck } from './project-check';
import { BACKUP_DIR, isTextFile, resolveTreePath, restoreLatestBackup, snapshotProject, trimPath, baseName } from './project-files';

/** The label of the pre-change snapshot (`.atlas-backup\change-<time>`). */
export const CHANGE_LABEL = 'change';
const MAX_HISTORY = 10;

export const NO_MODEL_CHANGE =
  'Changing something I built needs an AI model to write the code — turn one on in Settings → Intelligence, then ask again. Without one I can still recolour it (“make the whole app blue”, with an undo), replace text across it (“replace "old" with "new" in my game”) or open it (“play it”).';

const FACT = 'builder.last';
/** Text worth reading for the check; everything else is only listed. */
const READ_FOR_CHECK = (path: string) => isTextFile(path) || /\.(?:cmd|bat|svg)$/i.test(path);
const MAX_READ = 400;

export interface BuilderRecord {
  path: string;
  /** How it came to exist. */
  built: 'template' | 'agent';
  template?: string;
  goal?: string;
  at: number;
  /** The result of the last check, if one has run. */
  checked?: { ok: boolean; at: number };
  /** The changes asked for since it was built, newest last (at most ten). */
  changes?: Array<{ request: string; at: number; ok: boolean; verified: boolean; reverted?: boolean }>;
}

export interface BuilderLoopDeps {
  /** To reach `devagent.run` and `project.check` by name — the loop adds no second way to run either. */
  skills: SkillRegistry;
  /** Is a model connected right now? Asked at run time — the registry is built after these skills. */
  hasModel: () => boolean;
}

export function createBuilderSkills(
  platform: Platform,
  current?: { get(): Promise<string | null>; set(path: string): Promise<void> },
  memory?: Memory,
  loop?: BuilderLoopDeps,
): Skill[] {
  async function load(): Promise<BuilderRecord | null> {
    const fact = await memory?.fact('fact', FACT).catch(() => undefined);
    if (!fact?.value) return null;
    try {
      const r = JSON.parse(fact.value) as BuilderRecord;
      return typeof r.path === 'string' ? r : null;
    } catch {
      return null;
    }
  }
  const save = (r: BuilderRecord) => memory?.remember('fact', FACT, JSON.stringify(r)).catch(() => undefined);

  async function runCheck(root: string) {
    if (!platform.dirTree || !platform.readTextFile) return { error: "I can't look inside folders on this device." } as const;
    let tree;
    try {
      tree = await platform.dirTree(root, 6, 2000);
    } catch (e) {
      return { error: e instanceof Error ? e.message : `I couldn't look inside ${root}.` } as const;
    }
    const listed = tree
      .filter((t) => !t.isDirectory)
      .map((t) => resolveTreePath(root, t.path))
      .filter((r): r is { full: string; rel: string } => r !== null && !/(^|\/)(?:node_modules|\.git|\.atlas-backup)\//i.test(r.rel));
    const texts = new Map<string, string>();
    const unread: string[] = [];
    for (const f of listed.filter((f) => READ_FOR_CHECK(f.full)).slice(0, MAX_READ)) {
      try {
        texts.set(f.rel, await platform.readTextFile(f.full));
      } catch {
        unread.push(f.rel);
      }
    }
    const hasNodeModules = Boolean(await platform.pathInfo?.(`${root}\\node_modules`).catch(() => null));
    return checkProject({ allFiles: listed.map((f) => f.rel), texts, hasNodeModules, unread });
  }

  const check: Skill = {
    id: 'project.check',
    label: 'Check a built project',
    icon: '🔎',
    domain: 'project',
    description:
      'Look at a built project on disk and say whether it hangs together: something to open, every file its pages load is there, JSON files parse, package.json points at real files. It runs nothing and changes nothing, and it does not prove the program works.',
    needs: ['devtools'],
    risk: 'safe',
    examples: ['check the project I just built', 'check my project'],
    params: {
      path: { type: 'string', required: false, description: 'the project folder (defaults to your current project)' },
      built: { type: 'string', required: false, enum: ['template', 'agent'], description: 'how it was built, when this follows a build' },
      goal: { type: 'string', required: false, description: 'what it was built to do' },
      template: { type: 'string', required: false, description: 'which template it came from' },
    },
    async run(args) {
      const root = trimPath(String(args.path ?? '')) || (await current?.get()) || '';
      if (!root) return { ok: false, error: 'Which project? Give me the folder, or build something first.' };
      const info = await platform.pathInfo?.(root).catch(() => null);
      if (!info) return { ok: false, error: `I can't find ${root}.` };
      if (!info.isDirectory) return { ok: false, error: `${baseName(root)} is a file; point me at the project folder.` };
      const result = await runCheck(root);
      if ('error' in result) return { ok: false, error: result.error };
      await current?.set(root).catch(() => undefined);
      const prior = await load();
      const built = args.built === 'template' || args.built === 'agent' ? args.built : prior?.path === root ? prior.built : undefined;
      if (built) {
        await save({
          path: root,
          built,
          template: typeof args.template === 'string' ? args.template : prior?.path === root ? prior.template : undefined,
          goal: typeof args.goal === 'string' ? args.goal : prior?.path === root ? prior.goal : undefined,
          at: args.built ? Date.now() : (prior?.at ?? Date.now()),
          checked: { ok: result.ok, at: Date.now() },
          ...(prior?.path === root && prior.changes ? { changes: prior.changes } : {}),
        });
      }
      return { ok: true, message: formatCheck(baseName(root), result), aloud: false, data: { path: root, ...result } };
    },
  };

  const status: Skill = {
    id: 'builder.status',
    label: 'What I last built',
    icon: '🧱',
    domain: 'project',
    description: 'Say what Atlas last built for you: where it is, how it was made, and how it checks out now. Read-only.',
    needs: ['devtools'],
    risk: 'safe',
    examples: ['what did you build', 'what is my current app'],
    params: {},
    async run() {
      const rec = await load();
      const path = rec?.path ?? (await current?.get()) ?? '';
      if (!path) return { ok: true, message: 'I haven’t built anything for you yet. Try “build me a clicker game in D:\\Dev\\Clicker”.' };
      const result = await runCheck(path);
      const lines = [`🧱 ${baseName(path)} — ${path}`];
      if (rec) lines.push(`Built ${rec.built === 'template' ? `from the ${rec.template ?? 'ready-made'} template (no model)` : 'step by step by the developer agent'}${rec.goal ? `: “${rec.goal.length > 100 ? `${rec.goal.slice(0, 99)}…` : rec.goal}”` : ''}.`);
      else lines.push('It is your current project (I didn’t build it, or I’ve forgotten how).');
      if ('error' in result) lines.push(`I couldn’t check it now: ${result.error}`);
      else lines.push(result.ok ? `It checks out now: ${result.fileCount} files${result.entry ? `, opens from ${result.entry}` : ''}.` : `It has problems now: ${result.items.filter((i) => i.level === 'fail').map((i) => i.text).join(' ')}`);
      if (rec?.changes?.length) {
        const recent = rec.changes.slice(-3).map((c) => `• ${c.reverted ? 'undone: ' : ''}“${c.request.length > 70 ? `${c.request.slice(0, 69)}…` : c.request}” — ${c.ok ? (c.verified ? 'verified' : 'done, not verified') : 'did not finish'}`);
        lines.push(`${rec.changes.length} change${rec.changes.length === 1 ? '' : 's'} since:`, ...recent);
      }
      lines.push('Say “play it” to open it, ask for a change (“make the button bigger”), or “check the project I just built” for the full list.');
      return { ok: true, message: lines.join('\n'), aloud: false, data: { record: rec, check: 'error' in result ? null : result } };
    },
  };

  /** The project a change applies to: the one Atlas built, else the current project. */
  async function target(): Promise<{ root: string; record: BuilderRecord | null } | null> {
    const record = await load();
    const root = record?.path ?? (await current?.get()) ?? '';
    return root ? { root, record } : null;
  }

  const change: Skill = {
    id: 'builder.change',
    label: 'Change what I built',
    icon: '✏️',
    domain: 'project',
    description:
      'Change the project Atlas last built, as asked ("make the button bigger", "add a shop to it"): saves a snapshot of it first, has the developer agent make only that change, then checks the project again and says what changed and whether it was verified. Needs an AI model. "undo the last change" puts it back.',
    needs: ['devtools'],
    risk: 'confirm',
    examples: ['make the buttons bigger', 'add a shop to the game', 'change the title to Space Clicker'],
    params: {
      request: { type: 'string', required: true, description: 'the change, in the person’s own words' },
    },
    async run(args, ctx) {
      const request = String(args.request ?? '').trim().replace(/[.!]+$/, '');
      if (!request) return { ok: false, error: 'What would you like changed?' };
      const t = await target();
      if (!t) return { ok: false, error: 'I don’t have a project of mine to change yet. Build one first (“build me a clicker game in D:\\Dev\\Clicker”), or name the folder: “add a shop to D:\\Dev\\Game”.' };
      const { root, record } = t;
      const info = await platform.pathInfo?.(root).catch(() => null);
      if (!info?.isDirectory) return { ok: false, error: `I can’t find ${root} any more.` };
      if (!loop || !loop.hasModel()) return { ok: false, error: NO_MODEL_CHANGE };
      const agent = loop.skills.get('devagent.run');
      if (!agent) return { ok: false, error: 'The developer agent isn’t available here.' };

      // 1. Snapshot, so the change is one undoable step. No snapshot, no change.
      const snap = await snapshotProject(platform, root, CHANGE_LABEL);
      if (!snap.ok) return { ok: false, error: `I couldn’t save a copy of the project first (${snap.error}), so I haven’t changed anything.` };

      // 2. The targeted edit: the agent is told what the project is and to touch as little as it can.
      const goal = [
        `Change the existing project in this folder. The request: ${request}.`,
        record?.goal ? `The project was originally built to: ${record.goal}.` : '',
        'Read the files that matter first, then make ONLY this change with the smallest edits that do it. Keep everything else exactly as it is. Do not rewrite files you do not need to change. When done, run the project\'s own build or tests if it has them, and check the project.',
      ].filter(Boolean).join(' ');
      const ran = await agent.run({ goal, path: root }, ctx);
      const report = (ran.data ?? {}) as { verified?: boolean; unverified?: string; changed?: string[] };

      // 3. Look at what is on disk now.
      let checked: { ok: boolean; text: string } | null = null;
      const checker = loop.skills.get('project.check');
      if (checker) {
        const c = await Promise.resolve(checker.run({ path: root }, ctx)).catch(() => null);
        if (c?.ok) checked = { ok: Boolean((c.data as { ok?: boolean } | undefined)?.ok), text: String(c.message ?? '') };
      }
      const verified = Boolean(ran.ok && report.verified && checked?.ok);

      await current?.set(root).catch(() => undefined);
      const changed = report.changed ?? [];
      // A try that failed before touching anything leaves nothing to undo. Its spare copy goes to the
      // recycle bin, so a later "undo the last change" can only ever mean a change that really happened.
      const nothingHappened = !ran.ok && changed.length === 0;
      const discarded = nothingHappened ? Boolean(await platform.deletePath?.(snap.backup).catch(() => false)) : false;
      const base: BuilderRecord = record ?? { path: root, built: 'agent', at: Date.now() };
      await save({
        ...base,
        checked: checked ? { ok: checked.ok, at: Date.now() } : base.checked,
        changes: nothingHappened ? base.changes : [...(base.changes ?? []), { request, at: Date.now(), ok: ran.ok, verified }].slice(-MAX_HISTORY),
      });

      const lines: string[] = [];
      // The app puts its own warning mark in front of an error, so a failure does not carry one.
      lines.push(ran.ok ? `✏️ Done: “${request}”.` : `I didn’t finish “${request}”.`);
      if (changed.length) lines.push(`Changed: ${changed.slice(0, 8).join('; ')}${changed.length > 8 ? '…' : ''}.`);
      else lines.push(discarded ? 'Nothing was changed, so I threw away the spare copy.' : 'No file was changed.');
      if (checked) lines.push(checked.ok ? '✓ The project still hangs together.' : '✕ The project check found a problem — say “check the project I just built” for the list.');
      lines.push(verified ? '✓ A build/test passed after the change.' : `Not verified${report.unverified ? `: ${report.unverified}` : ran.ok ? '' : '.'}${ran.ok && !report.unverified ? ' — try it before relying on it.' : ''}`);
      if (snap.skipped) lines.push(`(${snap.skipped} file${snap.skipped === 1 ? ' was' : 's were'} too big to save a copy of, so an undo cannot bring those back.)`);
      if (!discarded) lines.push(`The files from before are in ${BACKUP_DIR}\\${baseName(snap.backup)} — say “undo the last change” to put them back, or tell me the next change.`);
      const data = { path: root, request, verified, backup: discarded ? null : snap.backup, report };
      // A failure is reported as one: the app shows `error` for a step that did not work, not `message`.
      return ran.ok ? { ok: true, message: lines.join('\n'), aloud: false, data } : { ok: false, error: lines.join('\n'), data };
    },
  };

  const revert: Skill = {
    id: 'builder.revert',
    label: 'Undo the last change to what I built',
    icon: '↩️',
    domain: 'project',
    description:
      'Put back the project files as they were before the last change Atlas made to it (from the snapshot taken first). Files the change created are left alone and listed; nothing is deleted.',
    needs: ['devtools'],
    risk: 'confirm',
    examples: ['undo the last change to my game'],
    params: {},
    async run(_args, ctx) {
      const t = await target();
      if (!t) return { ok: false, error: 'There is no project of mine to undo a change in.' };
      const { root, record } = t;
      const back = await restoreLatestBackup(platform, root, CHANGE_LABEL);
      if (!back.ok) return { ok: false, error: back.error };
      if ('none' in back) return { ok: true, message: 'There is no change to undo — I have no saved copy from before one.' };
      const changes = [...(record?.changes ?? [])];
      for (let i = changes.length - 1; i >= 0; i--) {
        if (!changes[i]!.reverted) {
          changes[i] = { ...changes[i]!, reverted: true };
          break;
        }
      }
      if (record) await save({ ...record, changes });
      const checker = loop?.skills.get('project.check');
      const c = checker ? await Promise.resolve(checker.run({ path: root }, ctx)).catch(() => null) : null;
      const ok = c?.ok ? (c.data as { ok?: boolean } | undefined)?.ok : undefined;
      return {
        ok: true,
        message: `↩️ Put back ${back.restored.length} file${back.restored.length === 1 ? '' : 's'} as they were before the last change.${ok === true ? ' ✓ The project hangs together.' : ok === false ? ' ✕ The project check still finds a problem.' : ''} Files the change added, if any, are still there — I don’t delete things.`,
        data: { path: root, restored: back.restored },
      };
    },
  };

  return [check, status, change, revert];
}
