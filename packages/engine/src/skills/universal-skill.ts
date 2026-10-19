/**
 * `agent.solve` — the one door into the universal agent (`universal/loop.ts`).
 *
 * Reached only when the person says so ("figure out how to…", "work out how to…"), never as an automatic
 * fallback, so nothing that already works changes. It is a skill like `ui.drive`: registered, risk-rated,
 * visible to the capability index, and every step it takes goes through the same executor and approvals.
 */

import type { ExecutionMode, IntelligenceRegistry, Skill } from '@atlas/core';
import type { SkillRegistry } from './registry';
import { Executor } from '../planner/executor';
import { createPhrasing, type Phrasing } from '../phrasing';
import { runUniversalTask } from '../universal/loop';
import type { AgentDeps } from '../agent/loop';

export interface UniversalAgentSkillOptions {
  skills: SkillRegistry;
  intelligence?: IntelligenceRegistry;
  phrasing?: Phrasing;
  getExecutionMode: () => ExecutionMode;
}

export function createUniversalAgentSkill(options: UniversalAgentSkillOptions): Skill {
  const deps: AgentDeps = {
    skills: options.skills,
    intelligence: options.intelligence,
    executor: new Executor(options.skills, options.phrasing ?? createPhrasing()),
    getExecutionMode: options.getExecutionMode,
  };
  return {
    id: 'agent.solve',
    label: 'Figure out a multi-step task',
    icon: '🧩',
    domain: 'atlas',
    description:
      'Work out a goal that needs several different steps, one at a time, choosing each next tool from everything Atlas can do and deciding from what actually happened. Each step is checked and asked about exactly as if you had requested it. Needs an AI model; ends when done, blocked, declined, stopped, or out of steps.',
    risk: 'confirm',
    examples: ['figure out how to free up space on my D drive', 'work out how to see which program is slowing my PC'],
    params: { goal: { type: 'string', required: true, description: 'what to accomplish' } },
    summarize: (args) => `work out: ${String(args.goal ?? '').slice(0, 80)}`,
    async run(args, ctx) {
      const report = await runUniversalTask(String(args.goal ?? ''), deps, ctx);
      return { ok: report.ok, message: report.message, spoken: true, data: report };
    },
  };
}
