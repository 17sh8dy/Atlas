/**
 * `ui.drive` — the one door into the UI-driving agent loop.
 *
 * A skill like any other, the same shape `devagent-skill.ts` established:
 * registered, capability-gated, risk-rated, and reached by the grammar, by
 * `planWithAI`, or directly. What it does inside `run()` is genuinely
 * different from every other skill (it calls Cortex itself and drives its
 * own inner `Executor`), but from the registry's point of view it is one
 * action with one argument. See `../uiagent/loop.ts`'s module doc for the
 * mechanism and why this task's `allow` check is an explicit skill-id set
 * rather than a domain, unlike devagent's.
 *
 * Kept in `skills/`, alongside every other skill-declaring file, rather than
 * beside `loop.ts` in `uiagent/` — domain-scanning tooling (the capability
 * browser's own guard test) reads this directory for `domain: '…'`
 * declarations, and a skill that lived somewhere else would silently miss it.
 */

import type { ExecutionMode, IntelligenceRegistry, Skill } from '@atlas/core';
import type { SkillRegistry } from './registry';
import { Executor } from '../planner/executor';
import { createPhrasing, type Phrasing } from '../phrasing';
import { runUiTask, type UiAgentDeps } from '../uiagent/loop';

export interface UiAgentSkillOptions {
  skills: SkillRegistry;
  intelligence?: IntelligenceRegistry;
  phrasing?: Phrasing;
  getExecutionMode: () => ExecutionMode;
}

export function createUiAgentSkill(options: UiAgentSkillOptions): Skill {
  const deps: UiAgentDeps = {
    skills: options.skills,
    intelligence: options.intelligence,
    executor: new Executor(options.skills, options.phrasing ?? createPhrasing()),
    getExecutionMode: options.getExecutionMode,
  };

  return {
    id: 'ui.drive',
    label: 'Drive another app',
    icon: '🧭',
    domain: 'uiagent',
    description:
      "Carry out a multi-step task inside another application's own UI — open it, read its controls, click and type through it — deciding each next step from what the screen actually shows after the last one, and stopping to explain why when the goal is done, blocked, or the step budget runs out. For a task that names both an application and something to do inside it, not for a single already-nameable action.",
    needs: ['ui-automation', 'window-control', 'input', 'apps'],
    risk: 'confirm',
    examples: [
      'go to the Nova server in Discord and start a call in the Hangouts channel',
      'in Spotify, find my Focus playlist and play it',
    ],
    params: {
      goal: { type: 'string', required: true, description: 'what to accomplish' },
    },
    async run(args, ctx) {
      const report = await runUiTask(String(args.goal), deps, ctx);
      // The loop already said its own final message via `ctx.say` — echoing
      // it again here is the double-narration `spoken: true` exists to stop,
      // the same way a skill that rendered its own result list uses it.
      return { ok: report.ok, message: report.message, spoken: true, data: report };
    },
  };
}
