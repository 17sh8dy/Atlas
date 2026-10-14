/**
 * What gets counted from what happened — names only, never content.
 *
 * `stats.rs` counts what it can see natively (model requests, web fetches, spoken replies,
 * confirmation questions, stops). The outcomes only the interface sees — an action finished,
 * failed or was declined; a task ended — are reported through this module, as names from a closed
 * list the native side enforces. No skill arguments, file names, prompts or results ever pass
 * through here: the input is the *shape* of an outcome and the skill id's family, and the output
 * is `[metric, count]` pairs.
 */

import type { AskOutcome } from '@atlas/engine';
import type { PlanOutcome, Task } from '@atlas/core';

export type Metric = [name: string, count: number];

/** Which family of things a skill is about, from its id alone. */
export function areaOf(skillId: string): string {
  const head = skillId.split('.')[0]?.toLowerCase() ?? '';
  if (['files', 'file', 'folder', 'folders', 'path', 'archive', 'recycle', 'cleanup', 'disk'].includes(head)) return 'area.files';
  if (['system', 'os', 'power', 'audio', 'display', 'settings', 'env', 'services', 'process', 'window', 'volume', 'wifi', 'network', 'printer', 'startup', 'theme', 'health', 'pc', 'hardware'].includes(head)) return 'area.system';
  if (['web', 'search', 'docs', 'research', 'browser', 'news', 'weather'].includes(head)) return 'area.web';
  if (['app', 'apps', 'launch', 'winget'].includes(head)) return 'area.apps';
  if (['dev', 'git', 'project', 'build', 'devtool', 'code', 'deploy', 'engine', 'scaffold'].includes(head)) return 'area.dev';
  if (['input', 'kbm', 'uia', 'mouse', 'keyboard', 'click', 'type'].includes(head)) return 'area.input';
  return 'area.other';
}

function add(into: Map<string, number>, name: string, n = 1) {
  if (n > 0) into.set(name, (into.get(name) ?? 0) + n);
}

export function metricsForPlan(plan: PlanOutcome): Metric[] {
  const m = new Map<string, number>();
  for (const step of plan.outcomes) {
    if (step.ok) {
      add(m, 'actions.done');
      add(m, areaOf(step.skill));
    } else if (step.skipped) {
      add(m, 'actions.declined');
    } else if (!plan.halted) {
      add(m, 'actions.failed');
    }
  }
  if (plan.halted) add(m, 'actions.halted');
  return [...m.entries()];
}

/** One typed message and how it ended. */
export function metricsForAsk(outcome: AskOutcome | undefined): Metric[] {
  const m = new Map<string, number>();
  add(m, 'chat.messages_sent');
  if (!outcome) return [...m.entries()];
  if (outcome.mode === 'halted') {
    add(m, 'actions.halted');
  } else if (outcome.mode === 'command') {
    for (const [k, n] of metricsForPlan(outcome.outcome)) add(m, k, n);
  } else if (outcome.ok) {
    add(m, outcome.via === 'model' ? 'chat.replies_model' : 'chat.replies_atlas');
  }
  return [...m.entries()];
}

/**
 * Tasks that newly reached an end state since `before`. The first call has no baseline and counts
 * nothing, so tasks that finished in an earlier session are not counted again at startup.
 */
export function taskMetrics(before: Map<string, Task['status']> | null, now: readonly Task[]): Metric[] {
  if (!before) return [];
  const m = new Map<string, number>();
  for (const t of now) {
    const was = before.get(t.id);
    if (was === t.status) continue;
    if (t.status === 'done') add(m, 'tasks.completed');
    else if (t.status === 'failed' || t.status === 'partial') add(m, 'tasks.failed');
    else if (t.status === 'cancelled') add(m, 'tasks.cancelled');
  }
  return [...m.entries()];
}
