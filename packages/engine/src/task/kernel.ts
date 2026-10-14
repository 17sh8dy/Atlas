/**
 * The task kernel: run a dependency-ordered set of steps through the ordinary executor, and keep
 * honest books on what happened.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 * It is not a second executor and it cannot act. It never calls a skill, never reads a platform
 * and never talks to a model. Every step is handed to `TaskHost.run`, which in Atlas is
 * `Engine.run` — the one validated executor — as a plan of exactly one step. So for every step:
 * the registry validates it, the content policy and guards screen it, the risk model and the
 * execution mode decide whether to ask, a declined card ends it, and the emergency stop aborts
 * it. The kernel only decides *which step goes next* and *what to write down*.
 *
 * ── The four execution modes, unchanged ────────────────────────────────────
 *  Do It? / Do It +   each step goes to the executor and is judged there, as typed.
 *  Confirm Actions    same; a plan is never approval, so nothing is pre-approved.
 *  Plan First         the whole task is shown once, up front (the executor's own plan card text),
 *                     and approving it covers exactly the steps shown: each is passed as
 *                     `approvedStep`, the same mechanism a Watch uses. Nothing off the card runs.
 *
 * ── Interruption and recovery ──────────────────────────────────────────────
 * A step is written down as `running` BEFORE it is handed over, and as its result after. So a
 * task that was cut off (the emergency stop, Atlas closing, a crash) knows which step was in
 * flight. What happens to that step depends on one thing — whether repeating it could do
 * something the first run did not:
 *   - safe to repeat (the risk model's `safe`): it goes back to `pending` and may run again;
 *   - anything else: it becomes `uncertain`, and is NEVER run again automatically. The person
 *     says retry, treat-as-done or skip, and a retry still passes through the executor's own
 *     confirmation like any other step.
 * A failed step is retried only if the caller asked, the step is safe to repeat, and the failure
 * kind is one that clears by itself (`busy`, `timeout`) — the recovery table in `failure.ts`.
 */

import type {
  ExecutionMode,
  Plan,
  PlanOutcome,
  PlanStep,
  Skill,
  SkillArgs,
  Task,
  TaskDecision,
  TaskPlan,
  TaskStep,
} from '@atlas/core';
import { FINISHED_TASK_STATUSES, HaltedError, classifyFailure, recoveryFor, summarizeTask } from '@atlas/core';
import type { EngineIO } from '../engine';
import type { SkillRegistry } from '../skills/registry';
import { fingerprintSteps } from '../watch/conditions';
import { checkGraph, dependentsOf, nextReady, orderedSteps } from './graph';
import type { TaskStore } from './store';

export interface TaskHost {
  /** `Engine.run`: the validated executor. The only way a step does anything. */
  run(plan: Plan, io: EngineIO, extra: { approvedStep(step: PlanStep): boolean }): Promise<PlanOutcome>;
  mode(): ExecutionMode;
  /** The executor's own plan-approval card text, so Plan First reads the same for a task. */
  planApproval(steps: ReadonlyArray<{ label: string; consequential: boolean }>): { question: string; detail: string };
}

export interface TaskKernelOptions {
  host: TaskHost;
  store: TaskStore;
  skills: SkillRegistry;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
}

/** The plan was refused before anything ran. Nothing was started and nothing was written. */
export class TaskPlanError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join(' '));
    this.name = 'TaskPlanError';
  }
}

type Listener = (tasks: readonly Task[]) => void;
type StepResult = 'done' | 'failed' | 'declined' | 'halted';

function riskOf(skill: Skill | null, args: SkillArgs): 'safe' | 'confirm' {
  const r = skill?.riskFor?.(args) ?? skill?.risk ?? 'safe';
  return r === 'confirm' ? 'confirm' : 'safe';
}

export class TaskKernel {
  private readonly host: TaskHost;
  private readonly store: TaskStore;
  private readonly skills: SkillRegistry;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;
  private readonly listeners = new Set<Listener>();
  private readonly cancelRequested = new Set<string>();
  private active: string | null = null;
  private counter = 0;
  private recovered = false;

  constructor(options: TaskKernelOptions) {
    this.host = options.host;
    this.store = options.store;
    this.skills = options.skills;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.newId = options.newId ?? (() => `t-${this.now().toString(36)}-${(++this.counter).toString(36)}`);
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async list(): Promise<Task[]> {
    await this.recover();
    return this.store.list();
  }

  async get(id: string): Promise<Task | null> {
    await this.recover();
    return (await this.store.list()).find((t) => t.id === id) ?? null;
  }

  /** The running task's id, if one is. */
  get running(): string | null {
    return this.active;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── starting ─────────────────────────────────────────────────────────────

  /**
   * Validate the whole plan, then run it. Validation is all-or-nothing and happens first: an
   * unknown skill, an unavailable one, a missing argument or a dependency cycle refuses the whole
   * task with nothing run — the rule `planWithAI` already follows for a model's plan.
   */
  async run(plan: TaskPlan, io: EngineIO): Promise<Task> {
    await this.recover();
    if (this.active) throw new TaskPlanError(['A task is already running. Wait for it, or press the emergency stop.']);

    const graph = checkGraph(plan.steps);
    const errors: string[] = graph.ok ? [] : [...graph.errors];
    const steps: TaskStep[] = [];
    if (graph.ok) {
      for (const spec of plan.steps) {
        const checked = this.skills.validate(spec.skill, spec.args ?? {});
        if (!checked.ok) {
          errors.push(`Step “${spec.id}”: ${checked.error}`);
          continue;
        }
        const skill = this.skills.get(spec.skill);
        steps.push({
          ...spec,
          args: checked.args,
          dependsOn: spec.dependsOn ? [...spec.dependsOn] : undefined,
          label: spec.label ?? skill?.label ?? spec.skill,
          status: 'pending',
          attempts: 0,
          safeToRepeat: riskOf(skill, checked.args) === 'safe',
        });
      }
    }
    if (errors.length) throw new TaskPlanError(errors);

    const at = this.now();
    const task: Task = {
      id: this.newId(),
      goal: plan.goal,
      source: plan.source,
      onFailure: plan.onFailure ?? 'stop',
      status: 'planned',
      createdAt: at,
      updatedAt: at,
      steps,
    };
    await this.save(task);

    const approval = await this.approve(task, io);
    if (!approval.approved) {
      for (const s of task.steps) {
        s.status = 'cancelled';
        s.reason = 'you said no';
      }
      task.status = 'cancelled';
      await this.save(task);
      return task;
    }
    return this.execute(task, io, approval.keys);
  }

  // ── resuming ─────────────────────────────────────────────────────────────

  /**
   * Carry on an interrupted or waiting task. A step whose fate is unknown needs a decision here;
   * without one it stays unknown and the task stays waiting — it is never assumed finished and
   * never repeated.
   */
  async resume(id: string, io: EngineIO, decisions: Record<string, TaskDecision> = {}): Promise<Task> {
    await this.recover();
    if (this.active) throw new TaskPlanError(['A task is already running.']);
    const task = await this.get(id);
    if (!task) throw new TaskPlanError([`There is no task ${id}.`]);
    if (task.status !== 'interrupted' && task.status !== 'awaiting') return task;

    for (const step of task.steps) {
      if (step.status !== 'uncertain') continue;
      const decision = decisions[step.id];
      if (decision === 'retry') {
        step.status = 'pending';
        step.reason = 'you asked for it to be run again';
      } else if (decision === 'treat-as-done') {
        step.status = 'done';
        step.reason = 'you said it had already happened';
        step.verified = undefined;
        step.evidence = undefined;
        step.endedAt = this.now();
      } else if (decision === 'skip') {
        step.status = 'skipped';
        step.reason = 'you skipped it';
      }
    }
    this.blockOrphans(task);

    if (task.steps.some((s) => s.status === 'uncertain')) {
      task.status = 'awaiting';
      await this.save(task);
      return task;
    }

    const approval = await this.approve(task, io);
    if (!approval.approved) {
      this.endUnreached(task, 'you said no');
      task.status = 'cancelled';
      await this.save(task);
      return task;
    }
    return this.execute(task, io, approval.keys);
  }

  /** Ask a running task to stop before its next step. The step in flight is the emergency stop's to end. */
  cancel(id: string): boolean {
    if (this.active !== id) return false;
    this.cancelRequested.add(id);
    return true;
  }

  // ── the loop ─────────────────────────────────────────────────────────────

  private async execute(task: Task, io: EngineIO, approved: Set<string>): Promise<Task> {
    this.active = task.id;
    this.cancelRequested.delete(task.id);
    task.status = 'running';
    await this.save(task);

    try {
      for (;;) {
        if (this.cancelRequested.has(task.id)) {
          this.endUnreached(task, 'you cancelled it');
          task.status = 'cancelled';
          await this.save(task);
          return task;
        }
        const step = nextReady(task);
        if (!step) break;

        const result = await this.runStep(task, step, io, approved);

        if (result === 'halted') {
          task.status = 'interrupted';
          await this.save(task);
          return task;
        }
        if (result === 'declined') {
          // Continuing after "no" is the most alarming thing an agent can do.
          this.endUnreached(task, 'you said no to a step');
          task.status = 'cancelled';
          await this.save(task);
          return task;
        }
        if (result === 'failed') {
          if (task.onFailure === 'stop') {
            this.endUnreached(task, `stopped after “${step.label}” failed`);
            break;
          }
          for (const dependent of dependentsOf(task, step.id)) {
            if (dependent.status === 'pending') {
              dependent.status = 'blocked';
              dependent.reason = `needs “${step.label}”, which did not finish`;
            }
          }
        }
        await this.save(task);
      }

      this.blockOrphans(task);
      task.status = this.finalStatus(task);
      await this.save(task);
      return task;
    } finally {
      this.active = null;
      this.cancelRequested.delete(task.id);
    }
  }

  private async runStep(task: Task, step: TaskStep, io: EngineIO, approved: Set<string>): Promise<StepResult> {
    for (;;) {
      step.status = 'running';
      step.attempts += 1;
      step.startedAt = this.now();
      step.endedAt = undefined;
      step.error = undefined;
      step.failure = undefined;
      step.reason = undefined;
      // Written down BEFORE it is handed over: if Atlas is cut off now, this is what recovery reads.
      await this.save(task);

      const plan: Plan = {
        source: 'routine',
        intent: `task:${task.goal.slice(0, 60)}`,
        confidence: 1,
        steps: [{ skill: step.skill, args: step.args }],
      };
      let outcome: PlanOutcome | null = null;
      let thrown: string | null = null;
      try {
        outcome = await this.host.run(plan, io, { approvedStep: (s) => approved.has(fingerprintSteps([s])) });
      } catch (e) {
        if (e instanceof HaltedError) {
          this.markInterruptedStep(step);
          return 'halted';
        }
        thrown = e instanceof Error ? e.message : String(e);
      }

      if (outcome?.halted) {
        this.markInterruptedStep(step);
        return 'halted';
      }

      const o = outcome?.outcomes[0];
      if (o?.ok && !o.skipped) {
        step.status = 'done';
        step.endedAt = this.now();
        step.message = o.message;
        step.verified = o.verified;
        step.evidence = o.evidence;
        return 'done';
      }

      // "Cancelled." is the executor's word for the person declining a card. "Refused." and every
      // other text is a failure of its own kind, not a no.
      if (o?.skipped && o.error === 'Cancelled.') {
        step.status = 'skipped';
        step.endedAt = this.now();
        step.reason = 'you said no';
        return 'declined';
      }

      const error = o?.error ?? thrown ?? 'It did not finish.';
      const kind = o?.failure ?? classifyFailure(error, { skipped: o?.skipped });
      const recovery = recoveryFor(kind);
      const may =
        step.retry !== undefined &&
        step.safeToRepeat &&
        recovery.action === 'retry-once' &&
        recovery.automatic &&
        step.attempts <= step.retry.max;
      if (may) {
        await this.sleep(Math.min(2000, 250 * step.attempts));
        if (this.cancelRequested.has(task.id)) {
          step.status = 'failed';
          step.error = error;
          step.failure = kind;
          step.endedAt = this.now();
          return 'failed';
        }
        continue;
      }

      step.status = 'failed';
      step.endedAt = this.now();
      step.error = error;
      step.failure = kind;
      return 'failed';
    }
  }

  /** A step cut off mid-way: repeatable ones may run again; anything else is unknown. */
  private markInterruptedStep(step: TaskStep): void {
    step.endedAt = this.now();
    if (step.safeToRepeat) {
      step.status = 'pending';
      step.reason = 'stopped while running; harmless to run again';
    } else {
      step.status = 'uncertain';
      step.reason = 'was in progress when it stopped, so I can’t tell whether it happened';
    }
  }

  // ── plan approval (Plan First only) ──────────────────────────────────────

  private async approve(task: Task, io: EngineIO): Promise<{ approved: boolean; keys: Set<string> }> {
    if (this.host.mode() !== 'planFirst') return { approved: true, keys: new Set() };
    const pending = orderedSteps(task.steps.filter((s) => s.status === 'pending'));
    const view = pending.map((s) => ({
      label: s.label,
      consequential: riskOf(this.skills.get(s.skill), s.args) === 'confirm',
    }));
    if (!view.some((v) => v.consequential)) return { approved: true, keys: new Set() };
    const card = this.host.planApproval(view);
    const yes = await io.confirm(card.question, card.detail);
    if (!yes) return { approved: false, keys: new Set() };
    return { approved: true, keys: new Set(pending.map((s) => fingerprintSteps([{ skill: s.skill, args: s.args }]))) };
  }

  // ── bookkeeping ──────────────────────────────────────────────────────────

  /** Steps that were never reached, because the task ended first. */
  private endUnreached(task: Task, why: string): void {
    for (const s of task.steps) {
      if (s.status === 'pending') {
        s.status = 'cancelled';
        s.reason = why;
      }
    }
  }

  /** A pending step whose prerequisite will never finish is blocked, not left hanging. */
  private blockOrphans(task: Task): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of task.steps) {
        if (s.status !== 'pending') continue;
        const dead = (s.dependsOn ?? [])
          .map((d) => task.steps.find((x) => x.id === d))
          .find((d) => d && (d.status === 'failed' || d.status === 'skipped' || d.status === 'blocked' || d.status === 'cancelled'));
        if (dead) {
          s.status = 'blocked';
          s.reason = `needs “${dead.label}”, which did not finish`;
          changed = true;
        }
      }
    }
  }

  private finalStatus(task: Task): Task['status'] {
    const sum = summarizeTask(task);
    if (sum.uncertain > 0 || sum.remaining > 0) return 'awaiting';
    if (sum.done === sum.total) return 'done';
    if (sum.done > 0) return 'partial';
    if (sum.failed > 0) return 'failed';
    return 'cancelled';
  }

  /**
   * A task the store still calls `running`, with nobody running it, was cut off. Read once per
   * kernel: what was in flight becomes pending (harmless) or uncertain (not safe to repeat).
   */
  private async recover(): Promise<void> {
    if (this.recovered) return;
    this.recovered = true;
    for (const task of await this.store.list()) {
      if (task.status !== 'running' && task.status !== 'planned') continue;
      if (task.id === this.active) continue;
      for (const s of task.steps) if (s.status === 'running') this.markInterruptedStep(s);
      task.status = 'interrupted';
      task.updatedAt = this.now();
      await this.store.save(task);
    }
  }

  private async save(task: Task): Promise<void> {
    task.updatedAt = this.now();
    await this.store.save(task);
    if (this.listeners.size) {
      const all = await this.store.list();
      for (const fn of this.listeners) fn(all);
    }
  }
}

// ── words ──────────────────────────────────────────────────────────────────

const STATUS_LINE: Record<Task['status'], string> = {
  planned: 'Not started',
  running: 'Running',
  awaiting: 'Waiting for you',
  interrupted: 'Stopped part-way',
  done: 'Done',
  partial: 'Partly done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * A task in plain words, saying only what the books support: which steps finished and whether
 * Atlas saw the effect, which failed and why, and which were never run — with the reason.
 */
export function describeTask(task: Task): string {
  const sum = summarizeTask(task);
  const lines = [`${STATUS_LINE[task.status]} — ${task.goal}`, `${sum.done} of ${sum.total} step${sum.total === 1 ? '' : 's'} finished.`];
  if (sum.done > 0) {
    const parts: string[] = [];
    if (sum.confirmed) parts.push(`${sum.confirmed} confirmed by reading the result back`);
    if (sum.unconfirmed) parts.push(`${sum.unconfirmed} could not be confirmed`);
    if (sum.reportedOnly) parts.push(`${sum.reportedOnly} reported done without a way to check`);
    if (parts.length) lines.push(parts.join('; ') + '.');
  }
  lines.push('');
  const mark: Record<TaskStep['status'], string> = {
    done: '✓',
    failed: '✗',
    uncertain: '?',
    blocked: '⛔',
    skipped: '–',
    cancelled: '–',
    pending: '…',
    running: '▶',
  };
  for (const s of orderedSteps(task.steps)) {
    const tail =
      s.status === 'done'
        ? s.verified === 'confirmed'
          ? ` — confirmed${s.evidence ? `: ${s.evidence}` : ''}`
          : s.verified === 'unconfirmed'
            ? ` — done, but I couldn’t confirm it${s.evidence ? `: ${s.evidence}` : ''}`
            : ''
        : s.status === 'failed'
          ? ` — ${s.error ?? 'failed'}`
          : s.reason
            ? ` — ${s.reason}`
            : '';
    lines.push(`${mark[s.status]} ${s.label}${tail}`);
  }
  if (sum.uncertain) {
    lines.push('', `${sum.uncertain} step${sum.uncertain === 1 ? '' : 's'} may or may not have happened. I won’t run ${sum.uncertain === 1 ? 'it' : 'them'} again unless you say so.`);
  }
  return lines.join('\n');
}

/** Used by tests and surfaces that want to know without a full report. */
export function isFinished(task: Pick<Task, 'status'>): boolean {
  return FINISHED_TASK_STATUSES.includes(task.status);
}
