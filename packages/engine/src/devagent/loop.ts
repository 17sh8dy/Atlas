/**
 * The developer agent's own configuration of the shared observe-act-replan
 * core — see `agent/loop.ts`'s module doc for the mechanism itself and why it
 * lives there now. This file supplies exactly what Phase 13 built: the
 * `project`/`git`/`build`/`test`/`code`/`files` domain allowlist, a 12-step
 * budget, and the "Project folder" context line every prompt carried. Every
 * name a caller already imports from here (`runDevTask`, `MAX_DEV_ITERATIONS`,
 * `DevAgentDeps`, `DevTaskReport`, …) still exists with the same shape — this
 * is a pure extraction, not a behaviour change, which is what lets Phase 13's
 * own tests keep pinning it unmodified.
 */

import type { SkillContext } from '@atlas/core';
import { runAgentTask, type AgentDeps, type AgentTaskReport } from '../agent/loop';

/** Small enough to bound a runaway task, large enough for a real one. */
export const MAX_DEV_ITERATIONS = 12;

/**
 * The only domains a dev-task step may touch. `files` is included because
 * inspecting a project legitimately wants `files.readText`/`files.list`
 * alongside the devtools-specific skills — this is not a second, wider
 * catalog, just the reads that already existed.
 */
const DEV_AGENT_DOMAINS = new Set(['project', 'git', 'build', 'test', 'code', 'files']);

export type DevTaskStepLog = AgentTaskReport['steps'][number];
export type DevTaskStopReason = AgentTaskReport['stoppedBecause'];
export type DevTaskReport = AgentTaskReport;
export type DevAgentDeps = AgentDeps;

export async function runDevTask(
  goal: string,
  cwd: string,
  deps: DevAgentDeps,
  ctx: SkillContext,
): Promise<DevTaskReport> {
  return runAgentTask(
    goal,
    {
      role: "developer agent",
      allow: (_skillId, domain) => DEV_AGENT_DOMAINS.has(domain),
      maxIterations: MAX_DEV_ITERATIONS,
      context: { 'Project folder': cwd },
      extraInstruction:
        'use the project folder above for any path/cwd argument unless a prior step told you a different one',
      noProviderMessage:
        'Dev tasks need Cortex connected — turn it on in Settings → Intelligence, then ask again.',
    },
    deps,
    ctx,
  );
}
