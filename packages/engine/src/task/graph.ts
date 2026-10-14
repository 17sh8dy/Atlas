/**
 * The shape of a task: which steps depend on which. Pure functions, no I/O.
 */

import type { Task, TaskStep, TaskStepSpec } from '@atlas/core';

/** More than this is a script, not a task a person can read and approve in one piece. */
export const MAX_TASK_STEPS = 25;

export type GraphCheck = { ok: true } | { ok: false; errors: string[] };

/** Ids unique, dependencies present, no step depending on itself, no cycles, a sane size. */
export function checkGraph(steps: readonly TaskStepSpec[]): GraphCheck {
  const errors: string[] = [];
  if (!steps.length) errors.push('A task needs at least one step.');
  if (steps.length > MAX_TASK_STEPS) {
    errors.push(`That is ${steps.length} steps; a task I can show you in one piece is at most ${MAX_TASK_STEPS}.`);
  }
  const ids = new Set<string>();
  for (const s of steps) {
    if (!s.id || typeof s.id !== 'string') errors.push('Every step needs an id.');
    else if (ids.has(s.id)) errors.push(`Two steps are both called “${s.id}”.`);
    ids.add(s.id);
  }
  for (const s of steps) {
    for (const dep of s.dependsOn ?? []) {
      if (dep === s.id) errors.push(`Step “${s.id}” depends on itself.`);
      else if (!ids.has(dep)) errors.push(`Step “${s.id}” depends on “${dep}”, which is not in the task.`);
    }
  }
  if (!errors.length) {
    const cycle = findCycle(steps);
    if (cycle) errors.push(`Steps depend on each other in a circle: ${cycle.join(' → ')}.`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** One cycle as a path of ids, or null. Iterative so a long chain cannot overflow the stack. */
export function findCycle(steps: readonly TaskStepSpec[]): string[] | null {
  const deps = new Map(steps.map((s) => [s.id, s.dependsOn ?? []] as const));
  const state = new Map<string, 0 | 1 | 2>(); // 1 = on the current path, 2 = finished
  for (const start of deps.keys()) {
    if (state.get(start) === 2) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    const path: string[] = [start];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const edges = deps.get(top.id) ?? [];
      if (top.next >= edges.length) {
        state.set(top.id, 2);
        stack.pop();
        path.pop();
        continue;
      }
      const dep = edges[top.next++]!;
      if (!deps.has(dep)) continue;
      if (state.get(dep) === 1) return [...path.slice(path.indexOf(dep)), dep];
      if (state.get(dep) !== 2) {
        state.set(dep, 1);
        stack.push({ id: dep, next: 0 });
        path.push(dep);
      }
    }
  }
  return null;
}

const byId = (task: Pick<Task, 'steps'>) => new Map(task.steps.map((s) => [s.id, s] as const));

/** The next step that may start: pending, every dependency done. Registration order breaks ties. */
export function nextReady(task: Pick<Task, 'steps'>): TaskStep | null {
  const index = byId(task);
  for (const step of task.steps) {
    if (step.status !== 'pending') continue;
    const ready = (step.dependsOn ?? []).every((d) => index.get(d)?.status === 'done');
    if (ready) return step;
  }
  return null;
}

/** Every step that depends, directly or through others, on `id`. */
export function dependentsOf(task: Pick<Task, 'steps'>, id: string): TaskStep[] {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const current = queue.pop()!;
    for (const s of task.steps) {
      if ((s.dependsOn ?? []).includes(current) && !out.has(s.id)) {
        out.add(s.id);
        queue.push(s.id);
      }
    }
  }
  return task.steps.filter((s) => out.has(s.id));
}

/** Steps in an order where every step follows what it depends on (stable). For showing a plan. */
export function orderedSteps<T extends TaskStepSpec>(steps: readonly T[]): T[] {
  const placed = new Set<string>();
  const out: T[] = [];
  let progressed = true;
  while (out.length < steps.length && progressed) {
    progressed = false;
    for (const s of steps) {
      if (placed.has(s.id)) continue;
      if ((s.dependsOn ?? []).every((d) => placed.has(d))) {
        placed.add(s.id);
        out.push(s);
        progressed = true;
      }
    }
  }
  return out;
}
