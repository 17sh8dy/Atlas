/**
 * Tasks as skills: run a recipe, list tasks, resume or cancel one.
 *
 * These are thin. `task.run` builds a recipe's plan and hands it to the kernel, whose every step
 * goes through the ordinary executor — so what this skill is *allowed* to do is exactly what the
 * steps it names are allowed to do, no more. It is `safe` for the same reason `workflow.transaction`
 * is: it asks for nothing itself, because each step asks for itself.
 */

import type { Skill, SkillContext, Task, TaskDecision } from '@atlas/core';
import type { EngineIO } from '../engine';
import { TaskPlanError, describeTask, type TaskKernel } from '../task/kernel';
import { RECIPES, findRecipe } from '../task/recipes';

/** What a skill is handed, as the engine-level io a kernel run needs. */
function ioOf(ctx: SkillContext): EngineIO {
  return {
    say: (text, options) => ctx.say(text, options),
    confirm: (question, detail, options) => ctx.confirm(question, detail, options),
    ...(ctx.offerFolder ? { offerFolder: ctx.offerFolder } : {}),
    ...(ctx.showResults ? { showResults: ctx.showResults } : {}),
  } as EngineIO;
}

function listLines(tasks: Task[]): string {
  if (!tasks.length) return 'No tasks yet.';
  return tasks
    .slice(-8)
    .reverse()
    .map((t) => `${new Date(t.updatedAt).toLocaleString()} — ${describeTask(t).split('\n')[0]}`)
    .join('\n');
}

export function createTaskSkills(kernel: TaskKernel): Skill[] {
  const run: Skill = {
    id: 'task.run',
    label: 'Run a task recipe',
    icon: '🧩',
    domain: 'task',
    description:
      'Run a ready-made multi-step task: the steps run in dependency order, each through the normal checks and approvals, progress is saved, and the report says what finished, what was confirmed and what was not run. Recipes: ' +
      RECIPES.map((r) => `${r.id} (${r.title})`).join('; ') +
      '.',
    risk: 'safe',
    examples: ['run the pc-checkup task', 'run the space-review task on Downloads', 'run the project-status task for D:\\Dev\\Atlas'],
    params: {
      recipe: { type: 'string', required: true, description: `one of: ${RECIPES.map((r) => r.id).join(', ')}`, enum: RECIPES.map((r) => r.id) },
      path: { type: 'string', required: false, description: 'the folder or project, for recipes that take one' },
      hours: { type: 'number', required: false, description: 'hours of errors to include, for pc-checkup' },
    },
    async run(args, ctx) {
      const recipe = findRecipe(String(args.recipe ?? ''));
      if (!recipe) return { ok: false, error: `I don’t have a task recipe called “${String(args.recipe)}”. Try: ${RECIPES.map((r) => r.id).join(', ')}.` };
      let plan;
      try {
        plan = recipe.build({
          path: args.path === undefined ? '' : String(args.path),
          hours: args.hours === undefined ? '' : String(args.hours),
        });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      try {
        const task = await kernel.run(plan, ioOf(ctx));
        const ok = task.status === 'done';
        const text = describeTask(task);
        return ok
          ? { ok: true, message: text, aloud: false, data: { id: task.id, status: task.status } }
          : { ok: false, error: text, data: { id: task.id, status: task.status } };
      } catch (e) {
        if (e instanceof TaskPlanError) return { ok: false, error: `I haven’t started anything: ${e.errors.join(' ')}` };
        throw e;
      }
    },
  };

  const list: Skill = {
    id: 'task.list',
    label: 'Recent tasks',
    icon: '🗂️',
    domain: 'task',
    description: 'List the most recent tasks Atlas ran, with where each one ended. Read-only.',
    risk: 'safe',
    examples: ['show my recent tasks'],
    params: {},
    async run() {
      return { ok: true, message: listLines(await kernel.list()), aloud: false };
    },
  };

  const resume: Skill = {
    id: 'task.resume',
    label: 'Resume a stopped task',
    icon: '⏯️',
    domain: 'task',
    description:
      'Carry on a task that was stopped part-way. A step that was in progress when it stopped cannot be known to have finished, so Atlas asks about each one; it never assumes it finished and never repeats it without being told.',
    risk: 'safe',
    examples: ['resume the task'],
    params: {},
    async run(_args, ctx) {
      const stopped = [...(await kernel.list())].reverse().find((t) => t.status === 'interrupted' || t.status === 'awaiting');
      if (!stopped) return { ok: true, message: 'There is no stopped task to resume.' };
      const decisions: Record<string, TaskDecision> = {};
      for (const step of stopped.steps.filter((s) => s.status === 'uncertain')) {
        const again = await ctx.confirm(
          `“${step.label}” was in progress when the task stopped, so I can’t tell whether it happened. Run it again?`,
          'Choose No to leave it as it is. I won’t assume it finished, and I won’t repeat it unless you say so.',
        );
        if (again) decisions[step.id] = 'retry';
      }
      try {
        const task = await kernel.resume(stopped.id, ioOf(ctx), decisions);
        return { ok: task.status === 'done', message: describeTask(task), error: task.status === 'done' ? undefined : describeTask(task), aloud: false, data: { id: task.id, status: task.status } };
      } catch (e) {
        if (e instanceof TaskPlanError) return { ok: false, error: e.errors.join(' ') };
        throw e;
      }
    },
  };

  const cancel: Skill = {
    id: 'task.cancel',
    label: 'Cancel the running task',
    icon: '⛔',
    domain: 'task',
    description: 'Stop the running task before its next step. The step already in progress is ended by the emergency stop.',
    risk: 'safe',
    examples: ['cancel the task'],
    params: {},
    async run() {
      const id = kernel.running;
      if (!id) return { ok: true, message: 'No task is running.' };
      kernel.cancel(id);
      return { ok: true, message: 'Okay — it will stop before its next step.' };
    },
  };

  return [run, list, resume, cancel];
}
