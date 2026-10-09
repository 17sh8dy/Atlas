/**
 * The shared core of every bounded observe-act-replan loop in Atlas: propose
 * one action from the selected model, run it through the real executor, fold what
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
 *  - The exact same failed call (skill + args) is never retried — if the model
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
 *
 * ── Added in 1.0.8 ──────────────────────────────────────────────────────────
 *  - A reply is read by `parseToolCall` (native function-call shapes, fences, string arguments, truncation).
 *  - Every tool result is shown to the model inside an UNTRUSTED fence, scanned for instruction-like text, and the
 *    addresses/paths/commands in flagged text are tainted: an action carrying one is refused (`web/untrusted.ts`).
 *  - The history is compacted to a budget instead of growing; the goal, rules and acceptance criteria are outside it.
 *  - The same failure three times ends the task with the failure shown; the second time the model is told to change tack.
 *  - A task that changed the project is reported `verified` only if a build / test / project check passed AFTER the
 *    last change. "Done" from the model is not enough, and the report says what changed even after a stop.
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
import { USE_RULES } from '../safety/use-rules';
import { HaltedError, untilHalted } from '@atlas/core';
import type { HaltSignal } from '@atlas/core';
import { parseToolCall } from './tool-call';
import { UNTRUSTED_RULE, fenceUntrusted, scanInjection, taintFrom, taintedBy } from '../web/untrusted';
import { TaskState, renderSpec, type ProjectSpec } from '../devagent/spec';

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
  /**
   * Only for tasks that change a project. `true`: a build / test / project check passed AFTER the last change and
   * nothing is failing. `false`: the project was changed and that was not observed. Absent: nothing was changed.
   * This is Atlas's own observation, never the model's word.
   */
  verified?: boolean;
  /** Why it is not verified, in a sentence. */
  unverified?: string;
  /** What the steps that succeeded changed, as "skill target". Answers "what did it change?" after a stop. */
  changed: string[];
  /** Actions refused because their arguments came from instruction-like text in a tool's output. */
  refused: string[];
}

export interface AgentDeps {
  skills: SkillRegistry;
  intelligence?: IntelligenceRegistry;
  executor: Executor;
  getExecutionMode: () => ExecutionMode;
  /**
   * How much of a prompt the model can really use, in characters, when known. The history of what has
   * happened is compacted to fit; it is never assumed that every model has the same room.
   */
  contextChars?: number;
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
  /** Shown when no model is connected. */
  noProviderMessage: string;
  /** What "done" means here. Shown every step with the status of each criterion Atlas has observed. */
  spec?: ProjectSpec;
  /** Extra context that changes as the task goes (research notes). Already fenced by whoever builds it. */
  dynamicContext?(): Record<string, string>;
  /**
   * A one-line hint to add to the history after a step, e.g. "docs.research could look this error up". Pure and
   * deterministic; it is Atlas's own advice, shown outside the untrusted block.
   */
  hintFor?(skillId: string, resultText: string, ok: boolean): string | undefined;
  /** Bounds the history block of the prompt, in characters. */
  historyChars?: number;
}

const DEFAULT_HISTORY_CHARS = 7000;
/** The newest entries are kept in full; older ones are squeezed to a line each. */
const KEEP_FULL = 3;

/** Skills that change the project, and the checks that vouch for it. Patterns, so a new skill is covered by its name. */
const WRITES = /^(?:code\.(?:write|edit|replaceAll|replaceAllUndo)|files\.(?:create|createFolder|append|rename|move|copy|delete|batchRename|mergeText|unzip)|project\.(?:create|scaffold|recolor|recolorUndo)|app\.scaffold|dependency\.|git\.(?:commit|merge|checkout|discardChanges|init|stash)|powershell\.run)/;
const CHECKS: Array<[RegExp, (args: SkillArgs) => string]> = [
  [/^build\.run$/, (a) => (a.target === 'typecheck' || a.target === 'lint' ? String(a.target) : 'build')],
  [/^test\.run$/, () => 'test'],
  [/^build\.diagnose$/, (a) => (a.what === 'test' ? 'test' : a.what === 'typecheck' || a.what === 'lint' ? String(a.what) : 'build')],
  [/^project\.check$/, () => 'project-check'],
  [/^script\.(?:python|node)$/, () => 'script'],
];

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

/** The same failure, whatever the line numbers, paths and counts: for noticing a loop that is going nowhere. */
function failureKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[a-z]:\\[^\s"']+|(?:\/[\w.-]+)+/g, '<path>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

interface HistoryEntry {
  full: string;
  compact: string;
}

/**
 * What has happened, within a character budget. The newest entries are shown whole; older ones shrink to one
 * line each; if that is still too much the oldest are dropped and the gap is said out loud. The goal, the
 * rules and the acceptance criteria are never part of this block, so shortening it cannot lose them.
 */
export function renderHistory(entries: readonly HistoryEntry[], budget: number): string {
  if (!entries.length) return 'Nothing has run yet.';
  const lines = entries.map((e, i) => (i >= entries.length - KEEP_FULL ? e.full : e.compact));
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  let start = 0;
  while (total > budget && start < lines.length - KEEP_FULL) {
    total -= lines[start]!.length + 1;
    start += 1;
  }
  const omitted = start > 0 ? [`(${start} earlier step${start === 1 ? '' : 's'} left out to save room — the project files hold their results)`] : [];
  return `What has happened so far:\n${[...omitted, ...lines.slice(start)].join('\n')}`;
}

const describeChange = (skill: string, args: SkillArgs) => {
  const target = args.path ?? args.file ?? args.target ?? args.name ?? args.package ?? '';
  return `${skill}${target ? ` ${String(target)}` : ''}`;
};

export async function runAgentTask(
  goal: string,
  config: AgentTaskConfig,
  deps: AgentDeps,
  ctx: SkillContext,
): Promise<AgentTaskReport> {
  const steps: AgentStepLog[] = [];
  const changed: string[] = [];
  const refused: string[] = [];
  const signal = ctx.signal;
  const state = new TaskState(config.spec ?? { goal, kind: 'unknown', stack: [], features: [], acceptance: [], open: [], milestones: [] });

  const base = (): Pick<AgentTaskReport, 'changed' | 'refused'> => ({ changed: [...changed], refused: [...refused] });
  const verification = (): Pick<AgentTaskReport, 'verified' | 'unverified'> => {
    if (!state.everChanged) return {};
    if (state.failingChecks.length) return { verified: false, unverified: `${state.failingChecks.join(', ')} ${state.failingChecks.length === 1 ? 'was' : 'were'} still failing at the end` };
    if (!state.verified) return { verified: false, unverified: 'the project was changed and no build, test or project check was run (and passed) afterwards' };
    return { verified: true };
  };

  const halted = (): AgentTaskReport => ({
    ok: false,
    message: '',
    steps,
    iterations: steps.length,
    stoppedBecause: 'halted',
    ...verification(),
    ...base(),
  });

  const finish = (ok: boolean, message: string, reason: AgentStopReason): AgentTaskReport => {
    const v = verification();
    // A task that changed the project and never saw it work is not reported as a success.
    let text = message;
    let good = ok;
    if (reason === 'done' && v.verified === false) {
      text = `${message}\n\n⚠ Not verified: ${v.unverified}. I can't tell you it works — run the build or tests to confirm.`;
      if (state.failingChecks.length) good = false;
    }
    if (changed.length && reason !== 'done') text = `${text}\nChanged so far: ${changed.slice(0, 8).join('; ')}${changed.length > 8 ? '…' : ''}.`;
    ctx.say(text);
    return { ok: good, message: text, steps, iterations: steps.length, stoppedBecause: reason, ...v, ...base() };
  };

  if (!deps.intelligence?.active()) {
    return finish(false, config.noProviderMessage, 'no-provider');
  }

  const catalog = catalogFor(deps.skills, config.allow);
  const history: HistoryEntry[] = [];
  const failed = new Set<string>();
  const failures = new Map<string, number>();
  const taint = new Set<string>();
  const goalLower = goal.toLowerCase();
  const budget = Math.min(config.historyChars ?? DEFAULT_HISTORY_CHARS, deps.contextChars ? Math.max(1500, Math.floor(deps.contextChars * 0.4)) : Infinity);
  let malformedStreak = 0;

  for (let i = 0; i < config.maxIterations; i++) {
    if (signal?.aborted) return halted();
    const contextLines = [
      ...Object.entries(config.context),
      ...Object.entries(config.dynamicContext?.() ?? {}),
    ].map(([label, value]) => `${label}: ${value}`);
    const actionsLine = config.extraInstruction
      ? `You may ONLY use these actions (${config.extraInstruction}):`
      : 'You may ONLY use these actions:';
    const prompt = [
      `You are Atlas's ${config.role}, working step by step toward one goal.`,
      `Goal: ${goal}`,
      USE_RULES + ' If the goal is like that, reply {"done":true,"summary":...} saying you will not do it.',
      UNTRUSTED_RULE,
      ...contextLines,
      ...(config.spec ? [renderSpec(config.spec, state)] : []),
      'Reply with JSON only, no prose. One of two shapes:',
      '  {"done":true,"summary":string} — the goal is complete, or cannot be; explain which and why. Do not say it is complete unless a build, test or check has passed since your last change.',
      '  {"skill":string,"args":object,"say"?:string} — one next action to take.',
      actionsLine,
      catalog,
      '',
      renderHistory(history, budget),
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
        "I lost the connection to the AI model partway through — here's what I'd done so far.",
        'no-provider',
      );
    }

    const parsed = parseToolCall(reply);
    if (parsed.kind === 'invalid') {
      malformedStreak += 1;
      if (malformedStreak >= 2) {
        return finish(
          steps.some((s) => s.ok),
          "I couldn't turn that into a clear next step, twice in a row — stopping rather than guessing.",
          'malformed',
        );
      }
      const hint =
        parsed.reason === 'truncated'
          ? 'It was cut off — send ONE short JSON object.'
          : parsed.reason === 'bad-arguments'
            ? `${parsed.detail} — "args" must be a JSON object.`
            : "It wasn't a single valid JSON action — try again.";
      history.push({ full: `(Your last reply was not usable: ${hint})`, compact: '(an unusable reply)' });
      continue;
    }
    malformedStreak = 0;
    const action: ProposedAction = parsed.action;

    if (action.done) {
      const summary =
        action.summary?.trim() || (steps.length ? 'Done.' : 'There was nothing to do.');
      return finish(true, summary, 'done');
    }

    const skillId = action.skill!;
    const domain = deps.skills.get(skillId)?.domain ?? '';
    if (!config.allow(skillId, domain)) {
      history.push({ full: `(${skillId} isn't one of the offered actions — ignored.)`, compact: `(${skillId}: not offered)` });
      continue;
    }

    const check = deps.skills.validate(skillId, (action.args ?? {}) as SkillArgs);
    if (!check.ok) {
      history.push({ full: `Tried ${skillId}: rejected — ${check.error}`, compact: `Tried ${skillId}: rejected` });
      continue;
    }

    // Nothing that came out of outside text may steer an action: if the arguments carry an address, path or
    // command that appeared in text which looked like instructions, the action is refused — before it ever
    // reaches an approval card dressed in an attacker's wording.
    const tainted = taintedBy(check.args, [...taint].filter((t) => !goalLower.includes(t)));
    if (tainted) {
      refused.push(`${skillId}: ${tainted}`);
      history.push({
        full: `(Refused ${skillId}: its arguments contain “${truncate(tainted, 80)}”, which came from text in a tool's output that looked like instructions — not from the user's goal. Pick a different step, or finish and tell the user.)`,
        compact: `(refused ${skillId}: came from untrusted text)`,
      });
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

    // What changed, and what vouches for it — from the executor's result, not from the model's description.
    if (ok && WRITES.test(skillId)) {
      changed.push(describeChange(skillId, check.args));
      state.changed();
      // The project is different now, so an action that failed before (the build, the tests) is worth running again —
      // that is exactly how a fix is proved. Only an UNCHANGED project makes a repeat pointless.
      failed.clear();
    }
    const checkRule = CHECKS.find(([re]) => re.test(skillId));
    if (checkRule) {
      const data = stepOutcome?.data as { ok?: boolean; result?: { ok?: boolean } } | undefined;
      // build.diagnose and project.check answer ok=true even when what they found is a failure; their data says which.
      const passed = skillId === 'build.diagnose' ? Boolean(ok && data?.result?.ok) : skillId === 'project.check' ? Boolean(ok && data?.ok) : ok;
      state.checked(checkRule[1](check.args), passed);
    }

    // Anything instruction-like in the output is remembered as data, and what it pointed at is tainted.
    const findings = scanInjection(resultText);
    if (findings.length) for (const t of taintFrom(resultText)) taint.add(t);

    const hint = config.hintFor?.(skillId, resultText, ok);
    let line = `${ok ? 'Ran' : 'Failed'} ${skillId}(${JSON.stringify(check.args)}): ${fenceUntrusted(skillId, resultText)}`;
    if (hint) line += `\nAtlas's hint: ${hint}`;

    // The same failure again and again, whatever the action: change approach, then stop.
    let nudge = '';
    if (!ok) {
      failed.add(signature);
      const key = failureKey(resultText);
      const n = (failures.get(key) ?? 0) + 1;
      failures.set(key, n);
      if (n >= 3) {
        history.push({ full: line, compact: `Failed ${skillId}` });
        return finish(
          steps.some((s) => s.ok),
          `The same problem came back ${n} times, so more of the same won't fix it. I'm stopping here rather than loop — the last failure was:\n${truncate(resultText, 400)}`,
          'repeated-failure',
        );
      }
      if (n === 2) nudge = "\nAtlas's note: this is the same failure as before. Try a different approach (read the file involved, look the error up with a documentation search, or change a different cause) — don't repeat the same fix.";
    }
    history.push({ full: line + nudge, compact: `${ok ? 'Ran' : 'Failed'} ${skillId}: ${truncate(resultText.replace(/\s+/g, ' '), 100)}` });
  }

  return finish(
    steps.some((s) => s.ok),
    `I made ${steps.filter((s) => s.ok).length} of ${steps.length} step${steps.length === 1 ? '' : 's'} work but ran out of steps before finishing.`,
    'budget',
  );
}
