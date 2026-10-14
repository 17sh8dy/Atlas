/**
 * Recipes: hand-written, deterministic task plans for goals that recur.
 *
 * A recipe is a function from a few parameters to a `TaskPlan` — steps, dependencies, nothing
 * else. It has no model, no randomness and no special powers: what it produces is an ordinary
 * task, validated and run like any other, so a recipe can never do something a person could not
 * have asked for step by step. The point is that "diagnose my slow PC" is one reliable thing to
 * say instead of five.
 *
 * A recipe earns its place by being *structure*, not wording: the dependency shape (what must
 * finish before what) is the value. The small set below are read-only; each says so.
 */

import type { TaskPlan } from '@atlas/core';

export interface RecipeParam {
  description: string;
  required: boolean;
}

export interface Recipe {
  id: string;
  title: string;
  /** One sentence for the person. */
  summary: string;
  params: Record<string, RecipeParam>;
  build(params: Record<string, string>): TaskPlan;
}

function need(params: Record<string, string>, key: string, what: string): string {
  const value = (params[key] ?? '').trim();
  if (!value) throw new Error(`This recipe needs ${what}.`);
  return value;
}

export const RECIPES: readonly Recipe[] = [
  {
    id: 'pc-checkup',
    title: 'PC check-up',
    summary: 'Read live load and recent Windows errors, then put them together in one performance report. Read-only.',
    params: {
      hours: { description: 'how many hours of Windows errors to include (default 24)', required: false },
    },
    build(params: Record<string, string>): TaskPlan {
      const hours = Number(params.hours) > 0 ? Math.min(168, Math.floor(Number(params.hours))) : 24;
      return {
        goal: 'Check how this PC is doing',
        source: 'recipe',
        onFailure: 'continue-independent',
        steps: [
          { id: 'load', skill: 'system.metrics', args: {}, label: 'Read live CPU, memory, GPU and disk', retry: { max: 1 } },
          { id: 'errors', skill: 'system.errors', args: { hours }, label: 'Read recent Windows errors', retry: { max: 1 } },
          // The report quotes both, so it waits for both; if either read fails it is not attempted.
          { id: 'report', skill: 'system.report', args: { hours }, label: 'Write the performance report', dependsOn: ['load', 'errors'] },
        ],
      };
    },
  },
  {
    id: 'space-review',
    title: 'Where is the space going?',
    summary: 'Size a folder, then list its biggest subfolders and biggest files. Read-only: nothing is deleted.',
    params: { path: { description: 'a folder path or a known folder name like Downloads', required: true } },
    build(params: Record<string, string>): TaskPlan {
      const path = need(params, 'path', 'a folder to look at');
      return {
        goal: `See what is taking space in ${path}`,
        source: 'recipe',
        onFailure: 'continue-independent',
        steps: [
          { id: 'size', skill: 'storage.folderSize', args: { path }, label: 'Measure the folder' },
          // Both listings only make sense once the folder is known to be readable.
          { id: 'folders', skill: 'storage.largestFolders', args: { path }, label: 'Find its biggest subfolders', dependsOn: ['size'] },
          { id: 'files', skill: 'storage.largestFiles', args: { path }, label: 'Find its biggest files', dependsOn: ['size'] },
        ],
      };
    },
  },
  {
    id: 'project-status',
    title: 'Project status',
    summary: 'Identify a project, show its layout and its git state. Read-only.',
    params: { path: { description: 'the project folder', required: true } },
    build(params: Record<string, string>): TaskPlan {
      const path = need(params, 'path', 'a project folder');
      return {
        goal: `Look over the project at ${path}`,
        source: 'recipe',
        onFailure: 'continue-independent',
        steps: [
          { id: 'detect', skill: 'project.detect', args: { path }, label: 'Identify the project' },
          { id: 'tree', skill: 'project.tree', args: { path }, label: 'Show its layout', dependsOn: ['detect'] },
          { id: 'git', skill: 'git.status', args: { path }, label: 'Show its git state', dependsOn: ['detect'] },
        ],
      };
    },
  },
];

export function findRecipe(id: string): Recipe | null {
  const key = id.trim().toLowerCase();
  return RECIPES.find((r) => r.id === key) ?? null;
}
