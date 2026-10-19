/**
 * The universal agent: the existing observe → act → re-plan loop (`agent/loop.ts`) pointed at the WHOLE
 * capability registry instead of one task's fixed filter.
 *
 * The devagent and the UI agent each see a small, fixed catalog because no model can usefully choose among
 * three hundred tools. This one does not show three hundred: every step it asks the `CapabilityIndex` for
 * the best few (the goal plus what has just happened, widened with the shared vocabulary) and shows only
 * those, so the prompt stays the same size however many capabilities exist. What it adds is only that
 * choice. Everything else is the loop that already ships:
 *
 *   · an action is admitted only if it was among the capabilities shown (this step or an earlier one) and
 *     is not on the short DENY list below; the model cannot name a tool it was never offered;
 *   · every admitted action is validated and run by the real `Executor`, so execution modes, previews,
 *     confirmations, Allowed Folders, the content policy, F8 and read-back verification all apply
 *     unchanged. A "yes" to one step never covers another;
 *   · a tool's output is fenced as untrusted, and an address, path or command that came from
 *     instruction-like text cannot steer a later action;
 *   · the same failure twice changes tack, three times ends the task; a budget ends it regardless.
 *
 * It does not pick itself: nothing calls it unless the person asked Atlas to "figure out how to…"
 * (`agent.solve`), and it needs a model connected.
 */

import type { Skill, SkillContext } from '@atlas/core';
import { runAgentTask, type AgentDeps, type AgentTaskReport } from '../agent/loop';
import { CapabilityIndex } from '../capabilities';
import { chainClauses } from './router';

/** Enough for a real multi-step job, few enough to end a task that is going nowhere. */
export const MAX_UNIVERSAL_ITERATIONS = 14;
/** Capabilities shown per step. */
export const CATALOG_SIZE = 14;

/**
 * Never available to the universal agent, however well they match: other agents (no agents inside agents),
 * and the skills that arrange for things to happen later or change what Atlas remembers or trusts. They are
 * for the person to ask for directly; an agent working through a goal has no business making them.
 */
const DENY = new Set([
  'devagent.run',
  'uiagent.run',
  'ui.drive',
  'agent.solve',
  'workflow.remember',
  'workflow.replay',
  'workflow.forget',
  'routine.create',
  'routine.cancel',
  'watch.create',
  'watch.cancel',
  'setup.run',
]);

function paramList(skill: Skill): string {
  return Object.entries(skill.params ?? {})
    .map(([n, p]) => `${n}${p.required ? '' : '?'}:${p.type}${p.enum ? `[${p.enum.join('|')}]` : ''}`)
    .join(', ');
}

export async function runUniversalTask(goal: string, deps: AgentDeps, ctx: SkillContext): Promise<AgentTaskReport> {
  const index = new CapabilityIndex(deps.skills);
  /** Everything that has been offered so far in this task (an earlier step's tool may be wanted again). */
  const offered = new Set<string>();

  const report = await runAgentTask(
    goal,
    {
      role: 'general task agent',
      maxIterations: MAX_UNIVERSAL_ITERATIONS,
      verifyProjectChanges: false,
      context: {},
      allow: (skillId) => offered.has(skillId) && !DENY.has(skillId),
      extraInstruction:
        'only these are available right now; the list changes as the task goes. Prefer the most specific one. Use powershell.run only if nothing else fits',
      noProviderMessage:
        'Working a task out step by step needs an AI model connected: turn one on in Settings → Intelligence, then ask again.',
      select({ goal: g, recent }) {
        const query = [g, ...recent].join(' ').slice(0, 600);
        const { hits } = index.disclose(query, { limit: CATALOG_SIZE });
        const lines: string[] = [];
        for (const { skill } of hits) {
          if (DENY.has(skill.id)) continue;
          offered.add(skill.id);
          lines.push(`${skill.id}(${paramList(skill)}) — ${skill.description}`);
        }
        return lines.length ? lines.join('\n') : '(nothing matches this goal; reply {"done":true,...} and say what is missing)';
      },
    },
    deps,
    ctx,
  );
  return withEvidence(goal, report, deps, ctx);
}

/**
 * What actually ran, in Atlas's own words, appended to the model's closing summary.
 *
 * A model asked to finish will sometimes claim more than it did ("the move is assumed complete" when the file
 * did not exist and no move was ever tried). The summary is the model's; this is the executor's record. When the
 * request had several parts and fewer actions succeeded than parts, the report says so instead of leaving the
 * claim standing.
 */
export function evidenceNote(goal: string, report: AgentTaskReport): string | null {
  const ran = report.steps.filter((s) => s.ok);
  const parts = chainClauses(goal).length;
  const lines: string[] = [];
  if (ran.length) lines.push(`What actually ran: ${ran.map((s) => s.skill).join(', ')}.`);
  else if (report.stoppedBecause === 'done') lines.push('No action actually ran.');
  if (report.stoppedBecause === 'done' && parts > 1 && ran.length < parts) {
    lines.push(`⚠ You asked for ${parts} things and ${ran.length} action${ran.length === 1 ? '' : 's'} succeeded, so do not take "done" at its word: check the rest.`);
  }
  return lines.length ? lines.join('\n') : null;
}

function withEvidence(goal: string, report: AgentTaskReport, _deps: AgentDeps, ctx: SkillContext): AgentTaskReport {
  const note = evidenceNote(goal, report);
  if (!note || report.stoppedBecause === 'no-provider') return report;
  ctx.say(note);
  return { ...report, message: `${report.message}\n\n${note}` };
}
