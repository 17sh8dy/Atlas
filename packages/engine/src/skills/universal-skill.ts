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
  /** The Settings switch. Required, so a caller cannot forget it: when it says no, the skill refuses outright. */
  isEnabled: () => boolean;
}

export const UNIVERSAL_AGENT_OFF =
  'The Universal Agent is off. It is experimental, so it only runs when you turn it on: Settings → Intelligence → Universal Agent.';

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
    params: {
      goal: { type: 'string', required: true, description: 'what to accomplish' },
      cautious: { type: 'boolean', required: false, description: 'ask before every action whatever the execution mode (set when Atlas offered this itself)' },
    },
    summarize: (args) => `work out: ${String(args.goal ?? '').slice(0, 80)}`,
    // Refused before any card is drawn, so an explicit "figure out how to…" does nothing while the feature is off.
    guard: () => (options.isEnabled() ? null : UNIVERSAL_AGENT_OFF),
    async run(args, ctx) {
      const run: AgentDeps = args.cautious === true ? { ...deps, getExecutionMode: () => 'confirmActions' } : deps;
      const report = await runUniversalTask(String(args.goal ?? ''), run, ctx);
      return { ok: report.ok, message: report.message, spoken: true, data: report };
    },
  };
}
