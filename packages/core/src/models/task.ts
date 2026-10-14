/**
 * Tasks: several steps with dependencies, run one at a time through the ordinary executor.
 *
 * A task is not a second way to act. Every step of a task is an ordinary plan step that goes
 * through the same validation, risk checks, execution mode, confirmations and emergency stop as
 * a step typed into the composer. What a task adds is *bookkeeping a single plan cannot hold*:
 * which steps depend on which, what was finished, what failed, what was never reached, and what
 * is genuinely unknown after an interruption — saved, so it survives Atlas closing.
 *
 * This file is data and a few pure functions. The running lives in `@atlas/engine`.
 */

import type { FailureKind } from './failure';
import type { PlanSource } from './plan';
import type { SkillArgs } from './skill';
import type { ProbeSpec, Verification } from './verify';

/**
 * Where a task is.
 *
 *  planned     — validated, not started.
 *  running     — a step is in flight or the next one is being chosen.
 *  awaiting    — stopped on purpose: a step's fate is unknown and only the person can say.
 *  interrupted — the emergency stop (or a crash) ended it mid-way. Nothing continues by itself.
 *  done        — every step finished.
 *  partial     — some steps finished and the rest did not, each with its reason. Said as such.
 *  failed      — nothing finished and something failed.
 *  cancelled   — the person (or a declined step) ended it.
 */
export type TaskStatus =
  | 'planned'
  | 'running'
  | 'awaiting'
  | 'interrupted'
  | 'done'
  | 'partial'
  | 'failed'
  | 'cancelled';

/**
 * Where one step is.
 *
 *  blocked   — a step it depends on did not finish, so it was not tried.
 *  uncertain — it was in flight when the task was interrupted and is not safe to repeat blind:
 *              Atlas cannot know whether it happened. Only the person can settle it.
 *  cancelled — never reached, because the task ended first.
 */
export type TaskStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'uncertain'
  | 'cancelled';

/** What a person says about a step whose fate is unknown. */
export type TaskDecision = 'retry' | 'treat-as-done' | 'skip';

/** What the caller supplies for one step. */
export interface TaskStepSpec {
  /** Unique within the task. Dependencies refer to it. */
  id: string;
  skill: string;
  args: SkillArgs;
  /** Shown in progress and reports. Defaults to the skill's own label. */
  label?: string;
  /** Steps that must be `done` before this one may start. */
  dependsOn?: string[];
  /**
   * What must be true once this step has reported success, as read-only probes (`verify.ts`).
   * Read back after the step, by the same probe runner the executor uses; a miss is said aloud and
   * the step is recorded as not confirmed. This is how a recipe — or, later, a model's plan —
   * states the effect it expects, so "done" can be told apart from "done, and I saw it".
   */
  expect?: ProbeSpec[];
  /** The step only reads. There is nothing to confirm about it, and it is reported as such. */
  readOnly?: boolean;
  /**
   * Try again on failure, at most this many extra times. Honoured only where retrying cannot do
   * more than the first attempt did: a step that is safe to repeat, failing in a way that
   * clears by itself (`busy`, `timeout`). Anything else is never retried, whatever is asked.
   */
  retry?: { max: number };
}

export interface TaskPlan {
  goal: string;
  /** Where the steps came from. A recipe is hand-written; `ai` came from a model and was validated like any plan. */
  source: PlanSource | 'recipe';
  steps: TaskStepSpec[];
  /**
   * What a failure does to the rest. `stop` (the default) ends the task at the first failure —
   * the executor's own rule for a plan. `continue-independent` blocks only the steps that
   * depended on the failed one and lets unrelated steps run; for read-only recipes.
   */
  onFailure?: 'stop' | 'continue-independent';
}

export interface TaskStep extends TaskStepSpec {
  label: string;
  status: TaskStepStatus;
  attempts: number;
  /**
   * Repeating this step does nothing the first run did not (no consequence beyond what was
   * already accepted): it is `safe` by the risk model. A step that is not may never be run again
   * automatically after an interruption.
   */
  safeToRepeat: boolean;
  startedAt?: number;
  endedAt?: number;
  message?: string;
  error?: string;
  failure?: FailureKind;
  verified?: Verification;
  evidence?: string;
  /** Why it is blocked, uncertain, skipped or cancelled, in a few words. */
  reason?: string;
}

export interface Task {
  id: string;
  goal: string;
  source: TaskPlan['source'];
  onFailure: NonNullable<TaskPlan['onFailure']>;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  steps: TaskStep[];
}

export const FINISHED_TASK_STATUSES: readonly TaskStatus[] = ['done', 'partial', 'failed', 'cancelled'];

export interface TaskSummary {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  blocked: number;
  uncertain: number;
  cancelled: number;
  remaining: number;
  /** Finished steps whose effect Atlas read back and saw. */
  confirmed: number;
  /** Finished steps Atlas tried to read back and could not confirm. */
  unconfirmed: number;
  /** Finished steps with nothing to read back that change something: reported done, not seen. */
  reportedOnly: number;
  /** Finished read-only steps: their result is what they returned; there was nothing to confirm. */
  reads: number;
}

export function summarizeTask(task: Pick<Task, 'steps'>): TaskSummary {
  const count = (s: TaskStepStatus) => task.steps.filter((x) => x.status === s).length;
  const done = task.steps.filter((x) => x.status === 'done');
  return {
    total: task.steps.length,
    done: done.length,
    failed: count('failed'),
    skipped: count('skipped'),
    blocked: count('blocked'),
    uncertain: count('uncertain'),
    cancelled: count('cancelled'),
    remaining: count('pending') + count('running'),
    confirmed: done.filter((x) => x.verified === 'confirmed').length,
    unconfirmed: done.filter((x) => x.verified === 'unconfirmed').length,
    reportedOnly: done.filter((x) => !x.verified && !x.readOnly).length,
    reads: done.filter((x) => !x.verified && x.readOnly).length,
  };
}
