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
  chooseTemplate,
  displayNameFor,
  idFor,
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
      description:
        'Write a complete starter project into a NEW folder, without needing a model: "clicker" is a finished desktop clicker game (generators, upgrades, ascension, huge numbers); "desktop" is a blank desktop app window; "website" is a one-page site. Refuses a folder that already has files in it. Follow it with dependency.installAll for a desktop template and project.launch to open it.',
      needs: ['devtools'],
      risk: 'confirm',
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
          description: 'which starter to write: clicker, desktop or website',
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

        const files = template.files({ name, id });
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
        return {
          ok: true,
          message: `Built ${name} - ${template.summary} - in ${root} (${files.length} files). ${template.tip}`,
          data: {
            path: root,
            template: template.id,
            name,
            files: written,
            launch: `${root}\\${template.launch}`,
            desktop: template.desktop,
          },
        };
      },
    },
  ];
}
