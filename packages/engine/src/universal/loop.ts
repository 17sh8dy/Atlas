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
import { runAgentTask, type AgentDeps, type AgentStepLog, type AgentStopReason, type AgentTaskReport } from '../agent/loop';
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

/** Skills that remove or end something, whatever their declared risk (some ask for themselves). */
const DESTRUCTIVE_ID = /(?:^|\.)(?:clean|delete|remove|empty|erase|wipe|uninstall|discard|endProcess|emptyRecycleBin|emptyFolder|kill)/i;

/** Words a goal may use for an enum value the model picked, beyond the value itself. */
const ENUM_ALIASES: Record<string, string[]> = {
  temp: ['temp', 'tmp', 'temporary'],
  crashdumps: ['crash', 'dump'],
  installers: ['installer', 'setup'],
};

/**
 * An action that removes things must be grounded in what was asked. The model once answered "delete the old log
 * files" with `cleanup.clean(kind: temp)`: a different set of files entirely, on a card showing 459 of them.
 * The card caught it; this stops it earlier. For a destructive skill, every enum choice must be something the
 * goal actually talks about. It can only refuse, never change the action.
 */
export function vetDestructive(skill: Skill | null, args: Record<string, unknown>, goal: string): string | null {
  if (!skill) return null;
  const destructive = skill.risk === 'confirm' || DESTRUCTIVE_ID.test(skill.id);
  if (!destructive) return null;
  // Only the WORDS of the request count: a folder that happens to be called "Temp" or "Downloads" in a path
  // must not make a request about log files look like it asked for a temp cleanup.
  const said = goal
    .replace(/[a-z]:[\\/][^\s"']*/gi, ' ')
    .replace(/(?:^|\s)(?:~?\/|\.{1,2}\/)[^\s"']*/g, ' ')
    .toLowerCase();
  for (const [name, param] of Object.entries(skill.params ?? {})) {
    const value = args[name];
    if (!param.enum || typeof value !== 'string' || !value) continue;
    const words = ENUM_ALIASES[value.toLowerCase()] ?? [value.toLowerCase().slice(0, Math.max(4, Math.min(value.length, 6)))];
    if (!words.some((w) => said.includes(w))) {
      return `the request never mentions "${value}", so ${skill.id} with ${name}=${value} is not what was asked.`;
    }
  }
  return null;
}

function paramList(skill: Skill): string {
  return Object.entries(skill.params ?? {})
    .map(([n, p]) => `${n}${p.required ? '' : '?'}:${p.type}${p.enum ? `[${p.enum.join('|')}]` : ''}`)
    .join(', ');
}

/** What a person is told about how far a task got, in Atlas's own words and never the model's. */
export type Completion = 'verified' | 'reported' | 'partial' | 'nothing';

export interface Assessment {
  completion: Completion;
  /** The parts of the request that no successful action covers. */
  unmet: string[];
}

/** Does this successful step merely look at things (so "confirmed" is not the right question)? */
function observational(deps: { skills: { get(id: string): Skill | null } }, id: string): boolean {
  const k = deps.skills.get(id);
  return Boolean(k && k.risk === 'safe' && !DESTRUCTIVE_ID.test(id) && !/(?:^|\.)(?:create|move|copy|rename|write|set|install|add|open|start|run|edit|append|zip|unzip|restart|mute|volume)/i.test(id));
}

/**
 * How far did this get? From the executor's record only. A part of the request counts as covered when some
 * SUCCESSFUL action is a capability the index also finds for that part of the sentence; the model saying "done"
 * counts for nothing.
 */
export function assess(goal: string, steps: readonly AgentStepLog[], index: CapabilityIndex, deps: { skills: { get(id: string): Skill | null } }): Assessment {
  const ok = steps.filter((st) => st.ok);
  const parts = chainClauses(goal);
  const unmet = parts.filter((part) => {
    const candidates = new Set(index.search(part, { limit: 8 }).map((h) => h.skill.id));
    return !ok.some((st) => candidates.has(st.skill));
  });
  if (!ok.length) return { completion: 'nothing', unmet: parts };
  if (unmet.length) return { completion: 'partial', unmet };
  const changing = ok.filter((st) => !observational(deps, st.skill));
  const allConfirmed = changing.length > 0 && changing.every((st) => st.verified === 'confirmed');
  return { completion: changing.length === 0 || allConfirmed ? 'verified' : 'reported', unmet: [] };
}

function stepLine(st: AgentStepLog, observed: boolean): string {
  const target = st.args && typeof st.args === 'object' ? String(Object.values(st.args).find((v) => typeof v === 'string' && v) ?? '') : '';
  const what = `${st.skill}${target ? ` (${target.length > 60 ? `…${target.slice(-57)}` : target})` : ''}`;
  if (!st.ok) return `✕ Failed: ${what}: ${st.summary.replace(/\s+/g, ' ').slice(0, 140)}`;
  if (st.verified === 'confirmed') return `✓ Confirmed by Atlas: ${what}${st.evidence ? `, ${st.evidence}` : ''}`;
  if (st.verified === 'unconfirmed') return `◐ Reported done, but Atlas could not confirm it: ${what}${st.evidence ? `, ${st.evidence}` : ''}`;
  return observed ? `• Looked at: ${what}` : `• Reported done by the tool; Atlas has no independent check for this one: ${what}`;
}

/**
 * The closing report: three things kept apart. WHAT ATLAS RECORDED (each step, and whether the machine was
 * read back to confirm it), WHAT IS NOT DONE (parts of the request no successful action covers), and, last and
 * labelled, WHAT THE MODEL SAID. The model's sentence is never allowed to stand in for the other two.
 */
export function frameReport(
  goal: string,
  view: { message: string; steps: readonly AgentStepLog[]; reason: AgentStopReason },
  index: CapabilityIndex,
  deps: { skills: { get(id: string): Skill | null } },
): string {
  if (view.reason === 'no-provider' && !view.steps.length) return view.message;
  const a = assess(goal, view.steps, index, deps);
  const headline: Record<Completion, string> = {
    verified: 'Done, and Atlas confirmed it.',
    reported: 'Done as far as the tools reported; Atlas could not independently confirm all of it.',
    partial: 'Only part of this was done.',
    nothing: 'Nothing was done.',
  };
  const lines = [headline[a.completion]];
  if (view.steps.length) lines.push('', ...view.steps.map((st) => stepLine(st, st.ok && observational(deps, st.skill))));
  if (a.unmet.length) lines.push('', `Not done: ${a.unmet.map((u) => `“${u}”`).join('; ')}.`);
  if (view.reason !== 'done') lines.push('', `It stopped because: ${view.message.replace(/\s+/g, ' ').trim()}`);
  else if (view.message.trim()) lines.push('', `The model's own summary (Atlas did not check this): ${view.message.replace(/\s+/g, ' ').trim()}`);
  return lines.join('\n');
}

/** Retry limits for a task that is going badly. */
export const MAX_FAILED_ACTIONS = 4;

export async function runUniversalTask(goal: string, deps: AgentDeps, ctx: SkillContext): Promise<AgentTaskReport> {
  const index = new CapabilityIndex(deps.skills);
  /** Everything that has been offered so far in this task (an earlier step's tool may be wanted again). */
  const offered = new Set<string>();

  return runAgentTask(
    goal,
    {
      role: 'general task agent',
      maxIterations: MAX_UNIVERSAL_ITERATIONS,
      maxFailures: MAX_FAILED_ACTIONS,
      verifyProjectChanges: false,
      context: {},
      allow: (skillId) => offered.has(skillId) && !DENY.has(skillId),
      vet: (skillId, args, g) => vetDestructive(deps.skills.get(skillId), args, g),
      // "Done" is checked against the executor's record. Up to twice the model is sent back to do the missing part
      // or to say what blocks it; the report then states what is and is not done whatever it answers.
      challengeDone: ({ goal: g, steps }) => {
        const a = assess(g, steps, index, deps);
        if (!a.unmet.length) return null;
        return `nothing that actually ran covers: ${a.unmet.map((u) => `"${u}"`).join('; ')}. Do that part now with one of the offered actions, or finish and say plainly what blocks it. Do not describe a step as done unless an action ran for it.`;
      },
      frame: ({ message, steps, reason }) => frameReport(goal, { message, steps, reason }, index, deps),
      extraInstruction:
        'only these are available right now; the list changes as the task goes. Prefer the most specific one. Use powershell.run only if nothing else fits. Never pick an action that removes or ends something unless the request names exactly what to remove; if nothing offered does exactly what was asked, reply done and say what is missing. Each part of the request needs its own action: never say a part is done, or "implied", unless an action ran for it',
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
}
