/**
 * The developer agent's loop: understand → inspect → act → observe → verify →
 * continue or finish, bounded and reusing the exact machinery every other
 * plan in this engine goes through.
 *
 * ── What this is, precisely ─────────────────────────────────────────────────
 * One proposed action at a time, from Cortex, re-planned every iteration
 * against what actually happened last time — the "observe and replan" shape
 * `docs/ROADMAP.md` names as a real gap (Phase 12's "Deferred, and why", and
 * the multi-step app-specific chains note), deliberately scoped down to
 * something tractable: the "observation" here is a build's stdout, a git
 * diff, a search result — plain text a model can read back — never a UI
 * Automation tree walk or a screen coordinate. That is what makes the loop
 * buildable at all without an iteration budget nobody could reason about.
 *
 * ── What makes it safe rather than a bare retry loop ────────────────────────
 *  - Every proposed step still runs through `Executor.run` — the same
 *    guard/confirm/risk/content-policy pipeline as a plan from the grammar or
 *    from `planWithAI`. This loop adds no new door to action; it just decides
 *    which single-step "plan" to hand the existing one, repeatedly.
 *  - A step may only name a skill in `DEV_AGENT_DOMAINS` — the same
 *    "relevant by construction" discipline `attemptGoal` uses for a single
 *    skill's own strategy ladder, applied here to a whole task: Cortex cannot
 *    steer this loop into `os.*` or `service.*` just because they exist in
 *    the wider catalog.
 *  - `MAX_DEV_ITERATIONS` bounds the whole task, the same shape as
 *    `MAX_ATTEMPTS` bounds a single skill's ladder, just larger because a
 *    real development task is genuinely multi-step.
 *  - The exact same failed call (skill + args) is never retried — if Cortex
 *    proposes it again, the loop stops and says so, rather than spinning.
 *  - A user declining a confirm step ends the task immediately, the same
 *    rule `Executor.run` already applies within one plan.
 *  - The emergency stop ends it harder than a decline: checked before every
 *    iteration, raced against every model call, and passed into every step.
 *    A halted task says nothing on its way out (the surface already shows
 *    the halt) and never starts another iteration.
 */

import type {
  ExecutionMode,
  IntelligenceRegistry,
  Plan,
  SkillArgs,
  SkillContext,
} from '@atlas/core';
import type { SkillRegistry } from '../skills/registry';
import type { Executor } from '../planner/executor';
import { HaltedError, untilHalted } from '@atlas/core';
import type { HaltSignal } from '@atlas/core';

/** Small enough to bound a runaway task, large enough for a real one. */
export const MAX_DEV_ITERATIONS = 12;

/**
 * The only domains a dev-task step may touch. `files` is included because
 * inspecting a project legitimately wants `files.readText`/`files.list`
 * alongside the devtools-specific skills — this is not a second, wider
 * catalog, just the reads that already existed.
 */
const DEV_AGENT_DOMAINS = new Set(['project', 'git', 'build', 'test', 'code', 'files']);

export interface DevTaskStepLog {
  skill: string;
  args: SkillArgs;
  ok: boolean;
  summary: string;
}

export type DevTaskStopReason =
  'done' | 'budget' | 'no-provider' | 'malformed' | 'repeated-failure' | 'declined' | 'halted';

export interface DevTaskReport {
  ok: boolean;
  message: string;
  steps: DevTaskStepLog[];
  iterations: number;
  stoppedBecause: DevTaskStopReason;
}

export interface DevAgentDeps {
  skills: SkillRegistry;
  intelligence?: IntelligenceRegistry;
  executor: Executor;
  getExecutionMode: () => ExecutionMode;
}

interface ProposedAction {
  done?: boolean;
  summary?: string;
  say?: string;
  skill?: string;
  args?: Record<string, unknown>;
}

function catalogFor(skills: SkillRegistry): string {
  const lines: string[] = [];
  for (const skill of skills.available()) {
    if (!DEV_AGENT_DOMAINS.has(skill.domain)) continue;
    const params = Object.entries(skill.params ?? {})
      .map(
        ([n, p]) =>
          `${n}${p.required ? '' : '?'}:${p.type}${p.enum ? `[${p.enum.join('|')}]` : ''}`,
      )
      .join(', ');
    lines.push(`${skill.id}(${params}) — ${skill.description}`);
  }
  return lines.join('\n');
}

/** Same promise-wrapping `Engine.planWithAI` uses — a provider may call
 * `onDone` synchronously, so `settled` guards against resolving twice. */
function askProvider(
  intelligence: IntelligenceRegistry | undefined,
  prompt: string,
  signal?: HaltSignal,
): Promise<string | null> {
  const provider = intelligence?.active();
  if (!provider) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    provider.ask(
      prompt,
      {
        onDelta: () => {},
        onDone: (full) => finish(full),
        onError: () => finish(null),
      },
      { signal },
    );
  });
}

function parseAction(reply: string): ProposedAction | null {
  try {
    const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as ProposedAction;
  } catch {
    return null;
  }
}

function signatureOf(skill: string, args: SkillArgs): string {
  const sorted = Object.keys(args)
    .sort()
    .map((k) => `${k}=${String(args[k])}`)
    .join('&');
  return `${skill}::${sorted}`;
}

function truncate(text: string, max = 1500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function runDevTask(
  goal: string,
  cwd: string,
  deps: DevAgentDeps,
  ctx: SkillContext,
): Promise<DevTaskReport> {
  const steps: DevTaskStepLog[] = [];
  const signal = ctx.signal;
  const halted = (): DevTaskReport => ({
    ok: false,
    message: '',
    steps,
    iterations: steps.length,
    stoppedBecause: 'halted',
  });

  const finish = (ok: boolean, message: string, reason: DevTaskStopReason): DevTaskReport => {
    ctx.say(message);
    return { ok, message, steps, iterations: steps.length, stoppedBecause: reason };
  };

  if (!deps.intelligence?.active()) {
    return finish(
      false,
      'Dev tasks need Cortex connected — turn it on in Settings → Intelligence, then ask again.',
      'no-provider',
    );
  }

  const catalog = catalogFor(deps.skills);
  const history: string[] = [];
  const failed = new Set<string>();
  let malformedStreak = 0;

  for (let i = 0; i < MAX_DEV_ITERATIONS; i++) {
    if (signal?.aborted) return halted();
    const prompt = [
      "You are Atlas's developer agent, working step by step toward one goal.",
      `Goal: ${goal}`,
      `Project folder: ${cwd}`,
      'Reply with JSON only, no prose. One of two shapes:',
      '  {"done":true,"summary":string} — the goal is complete, or cannot be; explain which and why.',
      '  {"skill":string,"args":object,"say"?:string} — one next action to take.',
      'You may ONLY use these actions (use the project folder above for any path/cwd argument unless a prior step told you a different one):',
      catalog,
      '',
      history.length ? `What has happened so far:\n${history.join('\n')}` : 'Nothing has run yet.',
    ].join('\n');

    let reply: string | null;
    try {
      reply = await untilHalted(askProvider(deps.intelligence, prompt, signal), signal);
    } catch (err) {
      if (err instanceof HaltedError) return halted();
      throw err;
    }
    if (!reply) {
      return finish(
        steps.some((s) => s.ok),
        "I lost the connection to Cortex partway through — here's what I'd done so far.",
        'no-provider',
      );
    }

    const action = parseAction(reply);
    if (!action || (!action.done && !action.skill)) {
      malformedStreak += 1;
      if (malformedStreak >= 2) {
        return finish(
          steps.some((s) => s.ok),
          "I couldn't turn that into a clear next step, twice in a row — stopping rather than guessing.",
          'malformed',
        );
      }
      history.push("(That reply wasn't a single valid JSON action — try again.)");
      continue;
    }
    malformedStreak = 0;

    if (action.done) {
      const summary =
        action.summary?.trim() || (steps.length ? 'Done.' : 'There was nothing to do.');
      return finish(true, summary, 'done');
    }

    const skillId = action.skill!;
    const domain = skillId.split('.')[0] ?? '';
    if (!DEV_AGENT_DOMAINS.has(domain)) {
      history.push(`(${skillId} isn't one of the offered actions — ignored.)`);
      continue;
    }

    const check = deps.skills.validate(skillId, (action.args ?? {}) as SkillArgs);
    if (!check.ok) {
      history.push(`Tried ${skillId}: rejected — ${check.error}`);
      continue;
    }

    const signature = signatureOf(skillId, check.args);
    if (failed.has(signature)) {
      return finish(
        steps.some((s) => s.ok),
        "That's the exact action that already failed — stopping rather than repeat it. Here's where things stand.",
        'repeated-failure',
      );
    }

    if (action.say) ctx.say(action.say);

    const plan: Plan = {
      source: 'ai',
      intent: 'dev-agent-step',
      steps: [{ skill: skillId, args: check.args }],
      confidence: 1,
    };
    const outcome = await deps.executor.run(plan, ctx, { mode: deps.getExecutionMode(), signal });
    if (outcome.halted) return halted();
    const stepOutcome = outcome.outcomes[0];

    if (stepOutcome?.skipped) {
      return finish(
        steps.some((s) => s.ok),
        'Stopped there, as asked.',
        'declined',
      );
    }

    const ok = Boolean(stepOutcome?.ok);
    const summary = truncate(
      ok ? (stepOutcome?.message ?? 'done') : (stepOutcome?.error ?? 'failed'),
      300,
    );
    steps.push({ skill: skillId, args: check.args, ok, summary });
    history.push(
      `${ok ? 'Ran' : 'Failed'} ${skillId}(${JSON.stringify(check.args)}): ${truncate(summary)}`,
    );
    if (!ok) failed.add(signature);
  }

  return finish(
    steps.some((s) => s.ok),
    `I made ${steps.filter((s) => s.ok).length} of ${steps.length} step${steps.length === 1 ? '' : 's'} work but ran out of steps before finishing.`,
    'budget',
  );
}
