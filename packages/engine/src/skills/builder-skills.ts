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
 * Planned for 1.0.9 (not here): request a change → targeted edit → rebuild → verify again.
 */

import type { Memory, Platform, Skill } from '@atlas/core';
import { checkProject, formatCheck } from './project-check';
import { isTextFile, resolveTreePath, trimPath, baseName } from './project-files';

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
}

export function createBuilderSkills(
  platform: Platform,
  current?: { get(): Promise<string | null>; set(path: string): Promise<void> },
  memory?: Memory,
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
      lines.push('Say “play it” to open it, or “check the project I just built” for the full list.');
      return { ok: true, message: lines.join('\n'), aloud: false, data: { record: rec, check: 'error' in result ? null : result } };
    },
  };

  return [check, status];
}
