/**
 * The shared core of every bounded observe-act-replan loop in Atlas: propose
 * one action from Cortex, run it through the real executor, fold what
 * actually happened back into the next prompt, repeat until done, blocked,
 * or out of budget.
 *
 * ── Where this came from ─────────────────────────────────────────────────────
 * Extracted from `devagent/loop.ts` (Phase 13's developer agent) once a
 * second, genuinely different task needed the identical shape: driving
 * another application's UI by reading its `uia.tree` and deciding a next
 * click, rather than reading a project's files and deciding a next build
 * step. The mechanism — one action at a time, replanned from what just
 * happened, through the same `Executor.run` every other plan uses — has
 * nothing task-specific in it. What *is* task-specific (which skills are
 * offered, how the goal is framed, what context lines the model needs every
 * turn) is exactly what `AgentTaskConfig` below parameterizes; `devagent/loop.ts`
 * is now a thin wrapper supplying the developer-agent's own config, and
 * `uiagent/loop.ts` supplies the UI-driving one. Neither wrapper's own tests
 * needed to change — this file changes nothing about what either task does,
 * only where the code that does it lives.
 *
 * ── What makes it safe rather than a bare retry loop (unchanged from Phase 13) ──
 *  - Every proposed step still runs through `Executor.run` — the same
 *    guard/confirm/risk/content-policy pipeline as a plan from the grammar or
 *    from `planWithAI`. This loop adds no new door to action; it just decides
 *    which single-step "plan" to hand the existing one, repeatedly.
 *  - A step may only name a skill `config.allow` admits — the same
 *    "relevant by construction" discipline `attemptGoal` uses for a single
 *    skill's own strategy ladder, applied here to a whole task.
 *  - `config.maxIterations` bounds the whole task, the same shape
 *    `MAX_ATTEMPTS` bounds a single skill's ladder.
 *  - The exact same failed call (skill + args) is never retried — if Cortex
 *    proposes it again, the loop stops and says so, rather than spinning.
 *  - A user declining a confirm step ends the task immediately, the same
 *    rule `Executor.run` already applies within one plan.
 *  - The emergency stop ends it harder than a decline: checked before every
 *    iteration, raced against every model call, and passed into every step.
 *
 * ── The one real addition beyond what Phase 13 built ────────────────────────
 * Devagent's own "observation" was always sufficient from `.message` alone —
 * every devtools read skill (`git.diff`, `git.status`, `code.search`, …)
 * already puts its real textual payload there, `.data` only ever a
 * structured copy of the same thing. `uia.tree` and `window.list` follow the
 * opposite convention: `.message` stays empty by design (there is no chat
 * card to narrate a raw control tree to), and the real payload — the thing a
 * replanning model actually needs to see to decide a next click — lives in
 * `.data`. `observationText` below is what makes that visible to this loop:
 * fall back to a compact rendering of `.data` only when `.message` has
 * nothing, which is exactly never for the tasks Phase 13 already shipped and
 * exactly always for a `uia.tree` read — so this changes no existing
 * behaviour and enables the new one.
 */

import type {
  ExecutionMode,
  IntelligenceRegistry,
  Plan,
  SkillArgs,
  SkillContext,
  StepOutcome,
} from '@atlas/core';
import type { SkillRegistry } from '../skills/registry';
import type { Executor } from '../planner/executor';
import { HaltedError, untilHalted } from '@atlas/core';
import type { HaltSignal } from '@atlas/core';

export interface AgentStepLog {
  skill: string;
  args: SkillArgs;
  ok: boolean;
  summary: string;
}

export type AgentStopReason =
  | 'done'
  | 'budget'
  | 'no-provider'
  | 'malformed'
  | 'repeated-failure'
  | 'declined'
  | 'halted';

export interface AgentTaskReport {
  ok: boolean;
  message: string;
  steps: AgentStepLog[];
  iterations: number;
  stoppedBecause: AgentStopReason;
}

export interface AgentDeps {
  skills: SkillRegistry;
  intelligence?: IntelligenceRegistry;
  executor: Executor;
  getExecutionMode: () => ExecutionMode;
}

/**
 * Everything that tells one task apart from another: what it may touch, how
 * long it may run, how the goal is framed, and what to say when there is no
 * model to run it with. Nothing here is optional — a caller that wants
 * devagent's exact current behaviour supplies devagent's exact current
 * values, which is what makes this a pure extraction rather than a behaviour
 * change for the existing caller.
 */
export interface AgentTaskConfig {
  /** How the model is told what it is, e.g. "developer agent", "UI-driving agent". */
  role: string;
  /**
   * Whether a step may touch this skill — the "relevant by construction"
   * gate every task's own catalog is filtered through. Devagent's own tasks
   * happen to line up one-to-one with `skill.domain` (`git.status` is
   * domain `git`), which is *why* it originally filtered on domain alone —
   * but that is a coincidence of how those skills were organised, not a rule
   * this loop can lean on generally: `uia.tree`, `window.focus` and
   * `input.click` all share `domain: 'system'` with `os.power` and
   * `service.stop`, which a UI-driving task must never be able to reach.
   * Given the full `id` (and its domain, for a config that still wants the
   * simple case) rather than deciding for the caller.
   */
  allow(skillId: string, domain: string): boolean;
  /** Bounds the whole task — the same shape `MAX_ATTEMPTS` bounds one skill's ladder. */
  maxIterations: number;
  /** Rendered every iteration as `label: value` lines, right after the goal. */
  context: Record<string, string>;
  /**
   * Appended as "(…)" onto the "You may ONLY use these actions" line — the
   * one place devagent's own prompt carried task-specific guidance ("use the
   * project folder above for any path/cwd argument…"). Omit when a task has
   * nothing to add.
   */
  extraInstruction?: string;
  /** Shown when Cortex isn't connected. */
  noProviderMessage: string;
}

interface ProposedAction {
  done?: boolean;
  summary?: string;
  say?: string;
  skill?: string;
  args?: Record<string, unknown>;
}

function catalogFor(skills: SkillRegistry, allow: AgentTaskConfig['allow']): string {
  const lines: string[] = [];
  for (const skill of skills.available()) {
    if (!allow(skill.id, skill.domain)) continue;
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

/**
 * The text this loop shows the model for one step's result. `.message` wins
 * whenever it has anything — which is every devtools read skill Phase 13
 * shipped against — and only falls back to a compact rendering of `.data`
 * when `.message` is empty, which is exactly the `uia.tree`/`window.list`
 * convention this loop was extended to read. See this file's module doc.
 */
function observationText(outcome: StepOutcome | undefined, ok: boolean): string {
  const message = outcome?.message?.trim();
  if (message) return message;
  if (ok && outcome?.data !== undefined) {
    try {
      return JSON.stringify(outcome.data);
    } catch {
      return 'done';
    }
  }
  return ok ? 'done' : (outcome?.error ?? 'failed');
}

export async function runAgentTask(
  goal: string,
  config: AgentTaskConfig,
  deps: AgentDeps,
  ctx: SkillContext,
): Promise<AgentTaskReport> {
  const steps: AgentStepLog[] = [];
  const signal = ctx.signal;
  const halted = (): AgentTaskReport => ({
    ok: false,
    message: '',
    steps,
    iterations: steps.length,
    stoppedBecause: 'halted',
  });

  const finish = (ok: boolean, message: string, reason: AgentStopReason): AgentTaskReport => {
    ctx.say(message);
    return { ok, message, steps, iterations: steps.length, stoppedBecause: reason };
  };

  if (!deps.intelligence?.active()) {
    return finish(false, config.noProviderMessage, 'no-provider');
  }

  const catalog = catalogFor(deps.skills, config.allow);
  const history: string[] = [];
  const failed = new Set<string>();
  let malformedStreak = 0;

  for (let i = 0; i < config.maxIterations; i++) {
    if (signal?.aborted) return halted();
    const contextLines = Object.entries(config.context).map(([label, value]) => `${label}: ${value}`);
    const actionsLine = config.extraInstruction
      ? `You may ONLY use these actions (${config.extraInstruction}):`
      : 'You may ONLY use these actions:';
    const prompt = [
      `You are Atlas's ${config.role}, working step by step toward one goal.`,
      `Goal: ${goal}`,
      ...contextLines,
      'Reply with JSON only, no prose. One of two shapes:',
      '  {"done":true,"summary":string} — the goal is complete, or cannot be; explain which and why.',
      '  {"skill":string,"args":object,"say"?:string} — one next action to take.',
      actionsLine,
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
    const domain = deps.skills.get(skillId)?.domain ?? '';
    if (!config.allow(skillId, domain)) {
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
      intent: 'agent-step',
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
    const resultText = observationText(stepOutcome, ok);
    const summary = truncate(resultText, 300);
    steps.push({ skill: skillId, args: check.args, ok, summary });
    history.push(
      `${ok ? 'Ran' : 'Failed'} ${skillId}(${JSON.stringify(check.args)}): ${truncate(resultText)}`,
    );
    if (!ok) failed.add(signature);
  }

  return finish(
    steps.some((s) => s.ok),
    `I made ${steps.filter((s) => s.ok).length} of ${steps.length} step${steps.length === 1 ? '' : 's'} work but ran out of steps before finishing.`,
    'budget',
  );
}
