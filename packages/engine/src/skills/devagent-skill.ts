/**
 * `devagent.run` — the one door into the developer-agent loop.
 *
 * A skill like any other: registered, capability-gated, risk-rated, and
 * reached by the grammar, by `planWithAI`, or directly. What it does inside
 * `run()` is genuinely different from every other skill (it calls Cortex
 * itself and drives its own inner `Executor`), but from the registry's point
 * of view it is one action with two arguments — which is exactly what keeps
 * it from becoming a second, competing execution path. See
 * `../devagent/loop.ts`'s module doc for the mechanism.
 *
 * Kept in `skills/`, alongside every other skill-declaring file, rather than
 * beside `loop.ts` in `devagent/` — domain-scanning tooling (the capability
 * browser's own guard test) reads this directory for `domain: '…'`
 * declarations, and a skill that lived somewhere else would silently miss it.
 */

import type { ExecutionMode, IntelligenceRegistry, Skill } from '@atlas/core';
import type { SkillRegistry } from './registry';
import { Executor } from '../planner/executor';
import { createPhrasing, type Phrasing } from '../phrasing';
import { runDevTask, type DevAgentDeps } from '../devagent/loop';

export interface DevAgentSkillOptions {
  skills: SkillRegistry;
  intelligence?: IntelligenceRegistry;
  phrasing?: Phrasing;
  getExecutionMode: () => ExecutionMode;
}

export function createDevAgentSkill(options: DevAgentSkillOptions): Skill {
  const deps: DevAgentDeps = {
    skills: options.skills,
    intelligence: options.intelligence,
    executor: new Executor(options.skills, options.phrasing ?? createPhrasing()),
    getExecutionMode: options.getExecutionMode,
  };

  return {
    id: 'devagent.run',
    label: 'Work on a development task',
    icon: '🛠️',
    domain: 'devagent',
    description:
      'Investigate a software project and carry out an open-ended development goal step by step — inspecting, searching, editing, building and testing — deciding each next step from what the last one actually showed, and stopping to explain why when the goal is done, blocked, or the step budget runs out.',
    needs: ['devtools'],
    risk: 'confirm',
    examples: [
      'fix the build errors in D:\\Dev\\NovaEngine',
      'find where the login form is validated in this project',
    ],
    params: {
      goal: { type: 'string', required: true, description: 'what to accomplish' },
      path: { type: 'string', required: true, description: 'the project folder to work in' },
    },
    async run(args, ctx) {
      const report = await runDevTask(String(args.goal), String(args.path), deps, ctx);
      // The loop already said its own final message via `ctx.say` — echoing
      // it again here is the double-narration `spoken: true` exists to stop,
      // the same way a skill that rendered its own result list uses it.
      return { ok: report.ok, message: report.message, spoken: true, data: report };
    },
  };
}
