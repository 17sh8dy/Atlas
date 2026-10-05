/**
 * "The project I'm working on" — so "git status" and "run the tests" do not
 * have to be followed by a path every time.
 *
 * The current project is remembered as a plain fact (`current-project`), set
 * two ways: said outright ("use D:\Dev\Atlas as my project"), or implied — any
 * developer skill that succeeds on a folder makes that folder the current one,
 * which is what "the project I was just in" means to a person.
 *
 * It is only ever used to fill in a *missing* path. A path that is given always
 * wins, and a spoken one ("atlas", "my atlas project") is resolved the same way
 * every other file target is, through a remembered name or the usual places.
 * Nothing is guessed when there is no current project: the answer is a question.
 */

import type { Memory, Platform, Skill } from '@atlas/core';
import { resolveTarget } from './locate';

const SUBJECT = 'current-project';

/** Skills that act on a project folder and take it as `path`. */
export const PROJECT_PATH_SKILLS = new Set([
  'project.detect',
  'project.tree',
  'code.search',
  'git.status',
  'git.diff',
  'git.log',
  'git.add',
  'git.commit',
  'git.branch',
  'git.checkout',
  'git.pull',
  'git.push',
  'git.stash',
  'git.merge',
  'git.tag',
  'git.tags',
  'git.unstage',
  'git.discardChanges',
  'git.init',
  'build.configure',
  'build.run',
  'test.run',
  'script.python',
  'script.node',
  'project.deploy',
  'project.recolor',
  'project.recolorUndo',
  'project.stats',
  'project.todos',
  'code.replaceAll',
  'code.replaceAllUndo',
  'dependency.install',
  'dependency.installAll',
]);

const ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\)/i;

export class ProjectContext {
  constructor(private readonly memory: Memory) {}

  async get(): Promise<string | null> {
    const f = await this.memory.fact('fact', SUBJECT).catch(() => undefined);
    return f?.value || null;
  }

  async set(path: string): Promise<void> {
    await this.memory.remember('fact', SUBJECT, path).catch(() => undefined);
  }
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * Wrap the developer skills so `path` may be left out (it falls back to the
 * current project) or spoken (it is resolved), and so a successful run makes
 * its folder the current project.
 */
export function withCurrentProject(
  skills: Skill[],
  ctx: ProjectContext,
  platform: Platform,
  memory?: Memory,
): Skill[] {
  return skills.map((skill) => {
    if (!PROJECT_PATH_SKILLS.has(skill.id) || !skill.params?.path) return skill;
    const params = { ...skill.params, path: { ...skill.params.path, required: false, description: `${skill.params.path.description} (defaults to your current project)` } };
    return {
      ...skill,
      params,
      async run(args, c) {
        let path = String(args.path ?? '').trim();
        if (path && !ABSOLUTE.test(path)) {
          const found = await resolveTarget(platform, memory, path);
          if (!found.ok) return { ok: false, error: found.error };
          path = found.path;
        }
        if (!path) {
          const current = await ctx.get();
          if (!current) {
            return {
              ok: false,
              error: 'Which project? Give me a folder, or say "use D:\\Dev\\MyApp as my project" once and I\'ll remember it.',
            };
          }
          path = current;
        }
        const result = await skill.run({ ...args, path }, c);
        if (result.ok) await ctx.set(path);
        return result;
      },
    };
  });
}

export function createProjectSkills(platform: Platform, ctx: ProjectContext, memory?: Memory): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'project.use',
    label: 'Use a project',
    icon: '📌',
    domain: 'project',
    description:
      'Make a folder the current project, so git, build and test requests that name no folder apply to it.',
    needs: ['devtools'],
    risk: 'safe',
    examples: ['use D:\\Dev\\Atlas as my project'],
    params: { target: { type: 'string', required: true, description: 'the project folder, or a remembered name' } },
    async run(args) {
      const t = await resolveTarget(platform, memory, String(args.target ?? ''));
      if (!t.ok) return { ok: false, error: t.error };
      try {
        const info = await platform.detectProject?.(t.path);
        await ctx.set(t.path);
        const bits = [...(info?.systems ?? []), ...(info?.isGitRepo ? ['git'] : [])];
        return {
          ok: true,
          message: `📌 Working in ${basename(t.path)}${bits.length ? ` (${bits.join(', ')})` : ''}.`,
          data: t.path,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : `I couldn't open ${t.path}.` };
      }
    },
  });

  skills.push({
    id: 'project.current',
    label: 'Which project',
    icon: '📌',
    domain: 'project',
    description: 'Say which project is the current one.',
    risk: 'safe',
    examples: ['which project am i working on'],
    params: {},
    async run() {
      const p = await ctx.get();
      return p
        ? { ok: true, message: `📌 ${basename(p)} — ${p}`, data: p }
        : { ok: true, message: 'No project is set yet. Say "use D:\\Dev\\MyApp as my project".' };
    },
  });

  skills.push({
    id: 'project.play',
    label: 'Play or open a project',
    icon: '▶️',
    domain: 'project',
    description:
      'Open the finished project the way a person would: its Play.cmd if it has one, otherwise its index.html, otherwise the folder. Defaults to the project just built.',
    needs: ['devtools'],
    // Opens something the person just asked to have built — the same class as app.open.
    risk: 'safe',
    examples: ['play it', 'open the game I just built'],
    params: { path: { type: 'string', required: false, description: 'the project folder (defaults to your current project)' } },
    async run(args) {
      let path = String(args.path ?? '').trim();
      if (path && !ABSOLUTE.test(path)) {
        const found = await resolveTarget(platform, memory, path);
        if (!found.ok) return { ok: false, error: found.error };
        path = found.path;
      }
      if (!path) path = (await ctx.get()) ?? '';
      if (!path) return { ok: false, error: 'Which project? Give me the folder, or build something first and I will open that.' };
      const exists = async (file: string) => Boolean(await platform.pathInfo?.(file).catch(() => null));
      // A game engine project: its project file (opened by the engine, if installed).
      const engineProject = async () => {
        if (await exists(`${path}\\project.godot`)) return `${path}\\project.godot`;
        const entries = (await platform.listDir?.(path, 200).catch(() => [])) ?? [];
        const uproject = entries.find((e) => !e.isDirectory && /\.uproject$/i.test(e.name));
        return uproject ? `${path}\\${uproject.name}` : null;
      };
      const target = (await exists(`${path}\\Play.cmd`))
        ? `${path}\\Play.cmd`
        : (await exists(`${path}\\index.html`))
          ? `${path}\\index.html`
          : ((await engineProject()) ?? path);
      try {
        const ok = await platform.openPath?.(target);
        if (!ok) return { ok: false, error: `I couldn't open ${target}.` };
        await ctx.set(path);
        return { ok: true, message: `▶️ Opened ${basename(target)}${target === path ? '' : ` from ${basename(path)}`}.` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : `I couldn't open ${target}.` };
      }
    },
  });

  const open = (id: string, label: string, icon: string, example: string, act: (path: string) => Promise<boolean> | undefined, done: string): Skill => ({
    id,
    label,
    icon,
    domain: 'project',
    description: `${label} for a project folder.`,
    needs: ['devtools'],
    // Opens a window on something the person just named — the same class as app.open.
    risk: 'safe',
    examples: [example],
    params: { path: { type: 'string', required: false, description: 'the project folder (defaults to your current project)' } },
    async run(args) {
      let path = String(args.path ?? '').trim();
      if (path && !ABSOLUTE.test(path)) {
        const found = await resolveTarget(platform, memory, path);
        if (!found.ok) return { ok: false, error: found.error };
        path = found.path;
      }
      if (!path) path = (await ctx.get()) ?? '';
      if (!path) return { ok: false, error: 'Which project? Say "use D:\\Dev\\MyApp as my project" first, or give me the folder.' };
      try {
        await act(path);
        await ctx.set(path);
        return { ok: true, message: `${icon} ${done} ${basename(path)}.` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  skills.push(
    open('project.terminal', 'Open a terminal', '🖥️', 'open a terminal in this project', (p) => platform.openProjectTerminal?.(p), 'Opened a terminal in'),
    open('project.editor', 'Open in VS Code', '📝', 'open this project in vscode', (p) => platform.openProjectEditor?.(p), 'Opened VS Code on'),
  );

  return skills;
}
