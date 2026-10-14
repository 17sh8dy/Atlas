/**
 * Bridges between the task vocabulary and the things that already run work: a plain `Plan`
 * (grammar, a saved routine, or — later — a model), a Watch, and a Setup's checks.
 *
 * These are *views and conversions*, not a merge. Watches, Setups and Routines keep their own
 * managers, stores and rules; what they share with tasks is one vocabulary for "where is it" so a
 * surface can show them in one list and so a plan from any source can become a task without a
 * separate path to execution.
 */

import type {
  Plan,
  SetupCheck,
  TaskPlan,
  TaskStatus,
  TaskStepStatus,
  Watch,
  WatchStatus,
  WatchStepState,
} from '@atlas/core';

/** A linear `Plan` as a task: each step depends on the one before it, the order it was given. */
export function taskPlanFromPlan(plan: Plan, options: { goal?: string; onFailure?: TaskPlan['onFailure'] } = {}): TaskPlan {
  return {
    goal: options.goal ?? (plan.intent || 'Run these steps'),
    source: plan.source,
    onFailure: options.onFailure ?? 'stop',
    steps: plan.steps.map((s, i) => ({
      id: `s${i + 1}`,
      skill: s.skill,
      args: s.args ?? {},
      dependsOn: i === 0 ? undefined : [`s${i}`],
    })),
  };
}

const WATCH_STATUS: Record<WatchStatus, TaskStatus> = {
  active: 'running',
  running: 'running',
  paused: 'interrupted',
  'awaiting-approval': 'awaiting',
  done: 'done',
  failed: 'failed',
  expired: 'cancelled',
  cancelled: 'cancelled',
};

const WATCH_STEP: Record<WatchStepState, TaskStepStatus> = {
  pending: 'pending',
  // A step written down as started and never finished is exactly an `uncertain` one.
  started: 'uncertain',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

export interface TaskView {
  id: string;
  kind: 'task' | 'watch' | 'setup';
  title: string;
  status: TaskStatus;
  steps: Array<{ label: string; status: TaskStepStatus; verified?: 'confirmed' | 'unconfirmed' }>;
}

/** A Watch in the shared vocabulary. Its own manager still owns it. */
export function taskViewFromWatch(w: Watch): TaskView {
  return {
    id: w.id,
    kind: 'watch',
    title: w.describe ? `Watching: ${w.describe}` : w.request,
    status: WATCH_STATUS[w.status],
    steps: w.stepLabels.map((label, i) => ({ label, status: WATCH_STEP[w.stepStates[i] ?? 'pending'] })),
  };
}

/**
 * A Setup's run in the shared vocabulary. A setup check is a read-back by construction, so a
 * passing check is `confirmed`; a skipped one (an app that was not running, nothing to close)
 * is `skipped`, not `done`.
 */
export function taskViewFromSetupChecks(name: string, checks: readonly SetupCheck[], describe: (c: SetupCheck) => string): TaskView {
  const steps = checks.map((c) => ({
    label: describe(c),
    status: (c.skipped ? 'skipped' : c.ok ? 'done' : 'failed') as TaskStepStatus,
    verified: c.skipped || !c.ok ? undefined : ('confirmed' as const),
  }));
  const done = steps.filter((s) => s.status === 'done').length;
  const failed = steps.filter((s) => s.status === 'failed').length;
  const status: TaskStatus = failed === 0 ? 'done' : done > 0 ? 'partial' : 'failed';
  return { id: `setup:${name}`, kind: 'setup', title: `Get ready for ${name}`, status, steps };
}
