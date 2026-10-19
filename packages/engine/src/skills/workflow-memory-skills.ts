/**
 * Saved workflows as skills: remember, replay, list, forget. See `workflow/memory.ts` for the rules
 * (replay is ordinary execution; no credentials stored; only real skills; bounded).
 *
 * `workflow.remember` makes its steps one of two ways, never by guessing:
 *   · `then` — a sentence, understood the way any request is understood (`planFor`), shown step by step;
 *   · otherwise the last thing Atlas did (`lastPlan`), which the person is shown before it is saved.
 * Either way the exact steps are on a card and only a yes saves them.
 */

import type { ExecutionMode, Plan, PlanStep, Skill, SkillContext } from '@atlas/core';
import type { SkillRegistry } from './registry';
import { Executor } from '../planner/executor';
import { createPhrasing, type Phrasing } from '../phrasing';
import { validateSteps, workflowKey, type WorkflowMemory } from '../workflow/memory';

export interface WorkflowMemorySkillDeps {
  memory: WorkflowMemory;
  skills: SkillRegistry;
  getExecutionMode: () => ExecutionMode;
  /** Understand a sentence without running it: `Engine.planFor`. */
  planFor: (text: string) => Promise<Plan | null>;
  /** The last plan Atlas ran, if any: `Engine.lastPlanned`. */
  lastPlan: () => Plan | null;
  phrasing?: Phrasing;
}

function describe(skills: SkillRegistry, step: PlanStep): string {
  const skill = skills.get(step.skill);
  const args = Object.entries(step.args ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([, v]) => String(v))
    .join(' · ');
  return `${skill?.label ?? step.skill}${args ? ` — ${args}` : ''}`;
}

export function createWorkflowMemorySkills(deps: WorkflowMemorySkillDeps): Skill[] {
  const { memory, skills } = deps;
  const executor = new Executor(skills, deps.phrasing ?? createPhrasing());

  return [
    {
      id: 'workflow.remember',
      label: 'Remember a workflow',
      icon: '💾',
      domain: 'workflow',
      description:
        'Save a list of steps under a name so they can be run again later ("remember this as my morning routine", "save a workflow called deploy: run the tests then open the site"). The steps are shown and only a yes saves them. Saving never runs anything, and nothing secret is stored.',
      risk: 'safe',
      examples: ['remember that as my morning routine'],
      params: {
        name: { type: 'string', required: true, description: 'what to call it' },
        then: { type: 'string', required: false, description: 'what it does, as a sentence; omit to save what I just did' },
      },
      async run(args, ctx) {
        const name = workflowKey(String(args.name ?? ''));
        if (!name) return { ok: false, error: 'What should I call it?' };
        const sentence = String(args.then ?? '').trim();
        let steps: PlanStep[];
        if (sentence) {
          const plan = await deps.planFor(sentence);
          if (!plan?.steps.length) return { ok: false, error: `I couldn't turn "${sentence}" into steps I can do.` };
          steps = plan.steps;
        } else {
          const last = deps.lastPlan();
          if (!last?.steps.length) return { ok: false, error: "I haven't done anything yet that I could save. Tell me what it should do." };
          steps = last.steps;
        }
        const checked = validateSteps(steps, (id) => skills.get(id) !== null);
        if (!checked.ok) return { ok: false, error: checked.error };
        const labels = checked.steps.map((s) => describe(skills, s));
        const approved = await ctx.confirm(
          `💾 Save "${name}"?`,
          `${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\nSaving does not run it. Each time you run it, every step is checked and asks you as usual.`,
        );
        if (!approved) return { ok: false, error: "Okay, I haven't saved it." };
        const saved = await memory.save(name, checked.steps, sentence || undefined);
        if (!saved.ok) return { ok: false, error: saved.error };
        return { ok: true, message: `💾 Saved "${name}" (${labels.length} step${labels.length === 1 ? '' : 's'}). Say "run ${name}" to use it.`, data: saved.workflow };
      },
    },
    {
      id: 'workflow.replay',
      label: 'Run a saved workflow',
      icon: '▶️',
      domain: 'workflow',
      description:
        'Run a workflow that was saved with "remember". Every step goes through the normal checks and asks you exactly as if you had just requested it; the emergency stop works. Stops at the first step that fails.',
      risk: 'safe',
      examples: ['run my morning routine'],
      params: { name: { type: 'string', required: true, description: 'the saved workflow, e.g. "morning routine"' } },
      async run(args, ctx: SkillContext) {
        await memory.load();
        const w = memory.get(String(args.name ?? ''));
        if (!w) {
          const have = memory.names();
          return { ok: false, error: have.length ? `I don't have a workflow like that. I have: ${have.join(', ')}.` : "You haven't saved any workflows yet." };
        }
        // Re-checked now: skills come and go, and credentials are refused again, not trusted from storage.
        const checked = validateSteps(w.steps, (id) => skills.get(id) !== null);
        if (!checked.ok) return { ok: false, error: `"${w.name}" can't run now: ${checked.error}` };
        const outcome = await executor.run(
          { source: 'direct', intent: 'workflow-replay', steps: checked.steps, confidence: 1 },
          ctx,
          { mode: deps.getExecutionMode(), signal: ctx.signal },
        );
        const total = checked.steps.length;
        const note = outcome.halted ? 'stopped' : outcome.ok ? 'all steps finished' : `${outcome.ran} of ${total} finished`;
        await memory.recordRun(w.name, note);
        const failed = outcome.outcomes.find((o) => !o.ok);
        if (outcome.ok) return { ok: true, message: `▶️ "${w.name}": ${total} step${total === 1 ? '' : 's'} finished.`, data: outcome };
        return {
          ok: false,
          error: outcome.halted ? `Stopped. ${outcome.ran} of ${total} steps had finished.` : `"${w.name}" stopped after ${outcome.ran} of ${total} steps${failed?.error ? `: ${failed.error}` : failed?.skipped ? ' (you declined a step).' : '.'}`,
          data: outcome,
        };
      },
    },
    {
      id: 'workflow.saved',
      label: 'My saved workflows',
      icon: '📚',
      domain: 'workflow',
      description: 'List the workflows that were saved, what each does, and how the last run went.',
      risk: 'safe',
      examples: ['what workflows have I saved'],
      params: {},
      async run() {
        await memory.load();
        const all = memory.all();
        if (!all.length) return { ok: true, message: "You haven't saved any workflows yet." };
        const lines = all.map((w) => `• ${w.name} — ${w.steps.map((s) => describe(skills, s)).join(' → ')}${w.runs ? ` · run ${w.runs}×${w.lastNote ? `, last: ${w.lastNote}` : ''}` : ''}`);
        return { ok: true, message: lines.join('\n'), data: all };
      },
    },
    {
      id: 'workflow.forget',
      label: 'Forget a saved workflow',
      icon: '🗑️',
      domain: 'workflow',
      description: 'Delete a saved workflow by name. It only removes the saved list of steps; nothing that already ran is undone.',
      risk: 'confirm',
      examples: ['forget my morning routine workflow'],
      params: { name: { type: 'string', required: true, description: 'the saved workflow' } },
      summarize: (args) => `forget the saved workflow "${String(args.name ?? '')}"`,
      async run(args) {
        const gone = await memory.remove(String(args.name ?? ''));
        return gone ? { ok: true, message: `🗑️ Forgot "${gone.name}".` } : { ok: false, error: "I don't have a workflow like that." };
      },
    },
  ];
}
