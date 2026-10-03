/**
 * `app.scaffold` — write a whole starter project into a new folder, with no model.
 *
 * The AI planner can already build a project file by file (`devagent.run`), but Atlas is meant to
 * be fully useful with nothing connected, and "build me a clicker game" must not end in "I didn't
 * catch that". This skill is the deterministic route: a request that names something Atlas has a
 * template for gets real, working files; one that does not is told so plainly (see
 * `../planner/app-grammar.ts`).
 *
 * It is no new kind of power. It is `platform.createFolder` followed by `platform.createFile` for
 * each file the template lists, the same two calls `project.create` and `files.create` make, and
 * it inherits everything they do: both are refused outside Allowed Folders (which is what raises
 * the "Add It?" card), and neither will overwrite anything. It also refuses to write into a folder
 * that already has things in it, so it can never mix a template into someone's project.
 *
 * It does not install or launch anything. The plan around it does (`dependency.installAll`,
 * `project.launch`), each through its own gate.
 */

import type { Platform, Skill } from '@atlas/core';
import {
  APP_TEMPLATE_IDS,
  allTemplates,
  chooseTemplate,
  displayNameFor,
  idFor,
  pascalFor,
  templateById,
  type AppTemplate,
} from '../templates';

function trimPath(path: string): string {
  return path.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Every folder a template's files need, parents first. */
function foldersNeeded(files: readonly { path: string }[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      if (!seen.has(folder)) {
        seen.add(folder);
        ordered.push(folder);
      }
    }
  }
  return ordered;
}

/**
 * A template's file paths come from the template, and a plugin's template comes from outside. Its
 * paths were checked when the plugin loaded; this checks them again where they are used, so no
 * path can ever climb out of the project folder, however a template was produced.
 */
export function unsafeFilePath(path: string): string | null {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return 'is not a relative path';
  if (path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    return 'climbs out of the folder or has an empty part';
  }
  for (const ch of path) {
    if (ch.charCodeAt(0) < 32 || '<>:"|?*'.includes(ch)) return 'has a character Windows does not allow';
  }
  return null;
}

/** Said after a game is built: the way past what hand-written code can do is a real engine. */
const ENGINE_NOTE =
  'When a game outgrows this (3D, big worlds, AAA scale) you will want a real game engine like Unreal, Unity or Godot; say “what game engines do I have” and I will set one up.';

export interface ScaffoldPlanInfo {
  template: AppTemplate;
  name: string;
  id: string;
}

export function resolveScaffold(args: {
  path?: unknown;
  template?: unknown;
  name?: unknown;
}): ScaffoldPlanInfo | { error: string } {
  const path = trimPath(String(args.path ?? ''));
  if (!path) return { error: 'Which folder should I build it in?' };
  const template = templateById(String(args.template ?? '')) ?? chooseTemplate(String(args.template ?? ''));
  if (!template) {
    return { error: `I can build: ${APP_TEMPLATE_IDS.join(', ')}. Which one?` };
  }
  const given = String(args.name ?? '').trim();
  const name = given || displayNameFor(baseName(path));
  return { template, name, id: idFor(name) };
}

/** Remembers the folder so "install dependencies" and "play it" mean this project. */
export interface CurrentProjectSetter {
  set(path: string): Promise<void>;
}

export function createAppScaffoldSkills(platform: Platform, current?: CurrentProjectSetter): Skill[] {
  return [
    {
      id: 'app.scaffold',
      label: 'Build a starter project',
      icon: '🧱',
      domain: 'project',
      // A getter, so a template a plugin adds later is described to the planner too.
      get description() {
        const lines = allTemplates().map((t) => `${t.id} (${t.summary})`);
        return `Write a complete, working starter project into a NEW folder, without needing a model. Templates: ${lines.join('; ')}. Refuses a folder that already has files in it. Follow it with dependency.installAll for a desktop template and project.play to open it.`;
      },
      needs: ['devtools'],
      risk: 'confirm',
      // "Build me a game" names no game: ask which, with the real choices as buttons.
      clarify(args) {
        const given = String(args.template ?? '');
        if (templateById(given) || chooseTemplate(given)) return null;
        const order: Record<string, number> = { game: 0, tool: 1, starter: 2, engine: 3 };
        const options = [...allTemplates()]
          .sort((a, b) => (order[a.group] ?? 9) - (order[b.group] ?? 9))
          .map((t) => ({ value: t.id, label: `${t.label.replace(/^an? /, '').replace(/^./, (c) => c.toUpperCase())} (${t.group})` }));
        return {
          param: 'template',
          noun: 'project',
          question: 'What kind of project should I build? These all work without a model.',
          many: false,
          options,
        };
      },
      confirmAs: (a) => {
        const found = resolveScaffold(a);
        return 'error' in found
          ? `build a project in ${String(a.path ?? 'a new folder')}`
          : `build ${found.template.label} named ${found.name} in ${trimPath(String(a.path))}`;
      },
      examples: ['build me a clicker game in D:\\Dev\\Clicker', 'make a website in D:\\Dev\\MySite'],
      params: {
        path: { type: 'string', required: true, description: 'the new project folder' },
        template: {
          type: 'string',
          required: true,
          enum: APP_TEMPLATE_IDS,
          description: 'which project to write: one of the template ids named in this skill\'s description',
        },
        name: {
          type: 'string',
          required: false,
          description: 'what to call it on screen; defaults to the folder name',
        },
      },
      async run(args) {
        const found = resolveScaffold(args);
        if ('error' in found) return { ok: false, error: found.error };
        const { template, name, id } = found;
        const root = trimPath(String(args.path));

        if (!platform.createFolder || !platform.createFile) {
          return { ok: false, error: "I can't write files on this device." };
        }

        // A folder that exists is only acceptable if it is empty.
        const existing = await platform.pathInfo?.(root).catch(() => null);
        let rootExists = false;
        if (existing) {
          if (!existing.isDirectory) return { ok: false, error: `${root} is a file, not a folder.` };
          const entries = (await platform.listDir?.(root, 1).catch(() => [])) ?? [];
          if (entries.length) {
            return {
              ok: false,
              error: `${baseName(root)} already has files in it. Pick a new folder name and I will build it there.`,
            };
          }
          rootExists = true;
        }

        const engines = (await platform.gameEngines?.().catch(() => [])) ?? [];
        const options = { name, id, pascal: pascalFor(name), engines };
        const files = template.files(options);
        for (const f of files) {
          const bad = unsafeFilePath(f.path);
          if (bad) return { ok: false, error: `That template tried to write ${JSON.stringify(f.path)}, which ${bad}. Nothing was written.` };
        }
        const written: string[] = [];
        try {
          if (!rootExists) await platform.createFolder(root);
          for (const folder of foldersNeeded(files)) {
            await platform.createFolder(`${root}\\${folder.replace(/\//g, '\\')}`);
          }
          for (const file of files) {
            await platform.createFile(`${root}\\${file.path.replace(/\//g, '\\')}`, file.content);
            written.push(file.path);
          }
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          const partial = written.length
            ? ` I had written ${written.length} of ${files.length} files (${written.join(', ')}) before it stopped; nothing was deleted.`
            : '';
          return { ok: false, error: `${why}${partial}` };
        }

        await current?.set(root).catch(() => undefined);
        const launch = template.launchFile?.(options) ?? template.launch;
        const advice = template.group === 'game' ? ` ${ENGINE_NOTE}` : '';
        return {
          ok: true,
          message: `Built ${name} - ${template.summary} - in ${root} (${files.length} files). ${template.tip}${advice}`,
          data: {
            path: root,
            template: template.id,
            name,
            files: written,
            launch: `${root}\\${launch}`,
            desktop: template.desktop,
          },
        };
      },
    },
  ];
}
